#!/usr/bin/env node
/**
 * runner/external_source_profile.js — deterministic live profiler for external sources
 *
 * Reads state/external_sources.json, fetches a small number of source homepages
 * and representative pages, extracts structural transparency markers, and writes
 * the enriched registry back. Failures are non-fatal.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { canonicalDomain } = require("./lib/url_utils");

const ROOT = path.resolve(__dirname, "..");
const REGISTRY = path.join(ROOT, "state", "external_sources.json");
const PROFILE_LIMIT = 4;
const STALE_MS = 3 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_HTML = 400_000;

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf-8"));
  } catch {
    return { schema_version: "1.0", generated_at: null, method: "discovery_only_mechanical", sources: [] };
  }
}

function writeRegistry(data) {
  fs.writeFileSync(REGISTRY, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function nowIso() {
  return new Date().toISOString();
}

function isStale(source) {
  const ts = source.profile?.fetched_at;
  if (!ts) return true;
  const ms = Date.parse(ts);
  return !Number.isFinite(ms) || (Date.now() - ms) > STALE_MS;
}

function pickTargets(registry) {
  return [...(registry.sources || [])]
    .filter(source => Array.isArray(source.discovery?.example_urls) && source.discovery.example_urls.length > 0)
    .sort((a, b) => {
      const staleDelta = Number(isStale(a)) - Number(isStale(b));
      if (staleDelta !== 0) return staleDelta;
      return (b.ratings?.overall?.score || 0) - (a.ratings?.overall?.score || 0);
    })
    .filter(source => isStale(source))
    .slice(0, PROFILE_LIMIT);
}

function chooseExampleUrl(source) {
  const urls = source.discovery?.example_urls || [];
  return urls.find(url => !/[?&](q|query)=/.test(url) && !/\/search/.test(url)) || urls[0] || null;
}

function homepageUrlFor(source) {
  return `https://${source.domain}/`;
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "User-Agent": "SebastianHunterBot/1.0" } });
    const contentType = res.headers.get("content-type") || "";
    const text = contentType.includes("html") ? (await res.text()).slice(0, MAX_HTML) : "";
    return {
      ok: res.ok,
      status: res.status,
      final_url: res.url,
      content_type: contentType,
      html: text,
    };
  } catch (error) {
    return { ok: false, status: null, final_url: url, content_type: "", html: "", error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function hasAny(html, patterns) {
  return patterns.some(pattern => pattern.test(html));
}

function countOutboundLinks(html, domain) {
  const matches = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"'#>]+)["']/gi)];
  const out = new Set();
  for (const match of matches) {
    try {
      const u = new URL(match[1]);
      const target = canonicalDomain(u.hostname);
      if (target && target !== domain) out.add(match[1]);
    } catch {}
  }
  return out.size;
}

function profileHtml(html, domain, url) {
  const lowerUrl = String(url || "").toLowerCase();
  return {
    has_meta_author: hasAny(html, [
      /<meta[^>]+(?:name|property)=["']author["']/i,
      /<meta[^>]+property=["']article:author["']/i,
      /rel=["']author["']/i,
    ]),
    has_published_time: hasAny(html, [
      /article:published_time/i,
      /name=["']pubdate["']/i,
      /<time[^>]+datetime=/i,
      /datepublished/i,
    ]),
    has_canonical: /<link[^>]+rel=["']canonical["']/i.test(html),
    has_about_link: hasAny(html, [
      /href=["'][^"']*\/about(?:\/|["'])/i,
      />\s*about\s*</i,
    ]),
    has_contact_link: hasAny(html, [
      /href=["'][^"']*\/contact(?:\/|["'])/i,
      />\s*contact\s*</i,
    ]),
    has_corrections_link: hasAny(html, [
      /href=["'][^"']*\/corrections?(?:\/|["'])/i,
      />\s*corrections?\s*</i,
      /editorial standards/i,
    ]),
    outbound_links_count: countOutboundLinks(html, domain),
    opinion_marker: /\/opinion\/|\/editorial\/|op-ed|opinion:/i.test(lowerUrl) || /opinion/i.test(html.slice(0, 4000)),
  };
}

function scoreProfile(homepage, example) {
  const signals = {
    has_meta_author: Boolean(example.has_meta_author),
    has_published_time: Boolean(example.has_published_time),
    has_canonical: Boolean(example.has_canonical),
    has_about_link: Boolean(homepage.has_about_link),
    has_contact_link: Boolean(homepage.has_contact_link),
    has_corrections_link: Boolean(homepage.has_corrections_link || example.has_corrections_link),
    outbound_links_count: example.outbound_links_count || 0,
    opinion_marker: Boolean(example.opinion_marker),
  };

  let score =
    (signals.has_meta_author ? 0.18 : 0) +
    (signals.has_published_time ? 0.18 : 0) +
    (signals.has_canonical ? 0.1 : 0) +
    (signals.has_about_link ? 0.14 : 0) +
    (signals.has_contact_link ? 0.12 : 0) +
    (signals.has_corrections_link ? 0.16 : 0) +
    Math.min(signals.outbound_links_count / 12, 1) * 0.12;

  if (signals.opinion_marker) score -= 0.08;

  return {
    score: Math.max(0, Math.min(1, score)),
    confidence: 0.55 + (signals.has_about_link ? 0.1 : 0) + (signals.has_meta_author ? 0.1 : 0) + (signals.has_published_time ? 0.1 : 0),
    signals,
    basis: [
      `meta_author:${signals.has_meta_author}`,
      `published_time:${signals.has_published_time}`,
      `canonical:${signals.has_canonical}`,
      `about:${signals.has_about_link}`,
      `contact:${signals.has_contact_link}`,
      `corrections:${signals.has_corrections_link}`,
      `outbound_links:${signals.outbound_links_count}`,
      `opinion_marker:${signals.opinion_marker}`,
    ],
  };
}

async function profileSource(source) {
  const homepageUrl = homepageUrlFor(source);
  const exampleUrl = chooseExampleUrl(source) || homepageUrl;

  const homepageRes = await fetchHtml(homepageUrl);
  const exampleRes = exampleUrl === homepageUrl ? homepageRes : await fetchHtml(exampleUrl);

  const homepageProfile = profileHtml(homepageRes.html || "", source.domain, homepageRes.final_url || homepageUrl);
  const exampleProfile = profileHtml(exampleRes.html || "", source.domain, exampleRes.final_url || exampleUrl);
  const rating = scoreProfile(homepageProfile, exampleProfile);

  source.profile = {
    fetched_at: nowIso(),
    homepage_url: homepageUrl,
    example_url: exampleUrl,
    homepage_status: homepageRes.status,
    example_status: exampleRes.status,
    homepage_final_url: homepageRes.final_url,
    example_final_url: exampleRes.final_url,
    homepage_content_type: homepageRes.content_type,
    example_content_type: exampleRes.content_type,
    homepage: homepageProfile,
    example: exampleProfile,
  };

  source.ratings = source.ratings || {};
  source.ratings.profile = {
    score: rating.score,
    confidence: Math.min(1, rating.confidence),
    basis: rating.basis,
  };
}

async function main() {
  const registry = readRegistry();
  const targets = pickTargets(registry);
  if (!targets.length) {
    console.log("[external_source_profile] nothing stale to profile");
    return;
  }

  for (const source of targets) {
    await profileSource(source);
  }

  registry.profiled_at = nowIso();
  writeRegistry(registry);
  console.log(`[external_source_profile] profiled ${targets.length} source(s)`);
}

main().catch(err => {
  console.error(`[external_source_profile] error: ${err.message}`);
  process.exit(0);
});
