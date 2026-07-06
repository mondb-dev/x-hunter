#!/usr/bin/env node
/**
 * scraper/rss_collect.js — RSS/Atom feed collector for news and research sources
 *
 * Fetches RSS/Atom feeds from curated trusted sources, converts items to the
 * same post-like format as collect.js, and appends new items to feed_digest.txt.
 * This gives the browse agent journalist-sourced and wire-service content
 * alongside X discourse.
 *
 * Pipeline per feed:
 *   1. Fetch RSS/Atom XML via HTTPS
 *   2. Parse items (title, link, description, pubDate)
 *   3. Deduplicate against state/rss_seen.json (rolling 3-day window)
 *   4. Score: news source tier weight × recency
 *   5. Append new items to state/feed_digest.txt in collect.js format
 *   6. Queue article URLs in state/reading_queue.jsonl (top 3 per run)
 *
 * State: state/rss_seen.json   — { url: isoDate } dedup map (rolling 3 days)
 *        state/rss_state.json  — { feed: { last_fetched: ISO } } fetch cadence
 *
 * Feeds are grouped by axis relevance so the digest carries context.
 * Edit the FEEDS array below to add/remove sources.
 *
 * Usage: node scraper/rss_collect.js
 * Called from run.sh every 6 browse cycles (BROWSE block, same cadence as follows.js).
 * Non-fatal — exits 0 on any error.
 */

"use strict";

const https  = require("https");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const ROOT      = path.resolve(__dirname, "..");
const STATE_DIR = path.join(ROOT, "state");

const DIGEST_FILE  = path.join(STATE_DIR, "feed_digest.txt");
const QUEUE_FILE   = path.join(STATE_DIR, "reading_queue.jsonl");
const SEEN_FILE    = path.join(STATE_DIR, "rss_seen.json");
const STATE_FILE   = path.join(STATE_DIR, "rss_state.json");

const SEEN_TTL_DAYS   = 3;     // dedup window
const MAX_QUEUE_URLS  = 3;     // max URLs to add to reading_queue per run
const FETCH_TIMEOUT   = 15000; // 15s per feed
const FETCH_COOLDOWN  = 3600;  // minimum seconds between fetches of same feed (1h)

// ── Feed registry ─────────────────────────────────────────────────────────────
// Add/remove feeds here. axis_hint is injected into the digest so the browse
// agent knows why this item is relevant to Sebastian's belief system.
//
// tier: 1 = wire service / official, 2 = major news, 3 = regional / specialist

const FEEDS = [
  // Global news — tier 1 wire/authority sources
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", name: "BBC World", tier: 1, axis_hint: "global_news" },
  { url: "https://www.theguardian.com/world/rss", name: "The Guardian", tier: 1, axis_hint: "global_news" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", name: "NYT World", tier: 1, axis_hint: "global_news" },

  // Philippine news (axis_hint: PH governance, power accountability)
  { url: "https://newsinfo.inquirer.net/feed", name: "Inquirer", tier: 2, axis_hint: "ph_governance_accountability" },
  { url: "https://www.philstar.com/rss/headlines", name: "Philippine Star", tier: 2, axis_hint: "ph_governance_accountability" },
  { url: "https://rappler.com/feed/", name: "Rappler", tier: 2, axis_hint: "ph_governance_accountability" },
  { url: "https://data.gmanetwork.com/gno/rss/news/feed.xml", name: "GMA News", tier: 2, axis_hint: "ph_governance_accountability" },
  { url: "https://pcij.org/feed/", name: "PCIJ", tier: 1, axis_hint: "ph_governance_accountability" }, // investigative — on-mission

  // Geopolitics & international relations
  { url: "https://www.aljazeera.com/xml/rss/all.xml", name: "Al Jazeera", tier: 2, axis_hint: "geopolitics_power" },

  // AI and technology (axis_hint: ai_societal_impact)
  { url: "https://feeds.arstechnica.com/arstechnica/technology-lab", name: "Ars Technica Tech", tier: 2, axis_hint: "ai_technology" },
  { url: "https://techcrunch.com/feed/", name: "TechCrunch", tier: 2, axis_hint: "ai_technology" },

  // Human rights and accountability
  { url: "https://www.hrw.org/rss", name: "Human Rights Watch", tier: 1, axis_hint: "human_rights_accountability" },
  { url: "https://www.amnesty.org/en/feed/", name: "Amnesty International", tier: 1, axis_hint: "human_rights_accountability" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(p, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}

function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
}

function appendLine(file, line) {
  fs.appendFileSync(file, line + "\n", "utf-8");
}

function sha1(str) {
  return crypto.createHash("sha1").update(str).digest("hex").slice(0, 12);
}

function secondsSince(isoDate) {
  if (!isoDate) return Infinity;
  return (Date.now() - new Date(isoDate).getTime()) / 1000;
}

function stripHtml(str) {
  return (str || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

function fetchUrl(url, timeoutMs = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);

    const req = protocol.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SebastianHunter/1.0; +https://sebastianhunter.fun)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml",
      },
    }, res => {
      // Follow redirects (max 3)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        clearTimeout(timer);
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString("utf-8")); });
      res.on("error", e => { clearTimeout(timer); reject(e); });
    });

    req.on("error", e => { clearTimeout(timer); reject(e); });
  });
}

// ── RSS/Atom parser (no dependencies) ─────────────────────────────────────────

function parseItems(xml) {
  const items = [];

  // RSS 2.0: <item> elements
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
    const link  = (block.match(/<link>([^<]+)<\/link>/) ||
                   block.match(/<link\s[^>]*href="([^"]+)"/) || [])[1];
    const desc  = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1];
    const pub   = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) ||
                   block.match(/<dc:date>([\s\S]*?)<\/dc:date>/) || [])[1];
    if (title && link) {
      items.push({
        title: stripHtml(title).slice(0, 200),
        url: link.trim(),
        description: stripHtml(desc || "").slice(0, 400),
        pub_date: pub ? new Date(pub.trim()).toISOString() : new Date().toISOString(),
      });
    }
  }

  // Atom: <entry> elements (if RSS items found nothing)
  if (items.length === 0) {
    const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const block of atomEntries) {
      const title  = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1];
      const link   = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1];
      const summ   = (block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) ||
                      block.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1];
      const pub    = (block.match(/<published>([\s\S]*?)<\/published>/) ||
                      block.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1];
      if (title && link) {
        items.push({
          title: stripHtml(title).slice(0, 200),
          url: link.trim(),
          description: stripHtml(summ || "").slice(0, 400),
          pub_date: pub ? new Date(pub.trim()).toISOString() : new Date().toISOString(),
        });
      }
    }
  }

  return items;
}

// ── Format item for feed_digest.txt ──────────────────────────────────────────

function formatDigestEntry(item, feed) {
  const ts   = item.pub_date.slice(0, 16).replace("T", " ");
  const tag  = `[RSS:${feed.name}]`;
  const tier = feed.tier === 1 ? "TIER1" : feed.tier === 2 ? "TIER2" : "TIER3";
  const desc = item.description ? `  SUMMARY: ${item.description.slice(0, 200)}` : "";
  return [
    `${tag} [${tier}] [${feed.axis_hint}] ${ts}`,
    `  TITLE: ${item.title}`,
    `  URL: ${item.url}`,
    desc,
    "",
  ].filter(l => l !== undefined).join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const seen    = loadJson(SEEN_FILE, {});
  const state   = loadJson(STATE_FILE, {});
  const now     = new Date().toISOString();

  // Prune stale seen entries (older than TTL)
  const cutoff = Date.now() - SEEN_TTL_DAYS * 86_400_000;
  for (const [url, ts] of Object.entries(seen)) {
    if (new Date(ts).getTime() < cutoff) delete seen[url];
  }

  let totalNew   = 0;
  const toQueue  = [];   // top items to add to reading_queue

  for (const feed of FEEDS) {
    // Rate-limit: skip if fetched recently
    const lastFetched = state[feed.url]?.last_fetched;
    if (secondsSince(lastFetched) < FETCH_COOLDOWN) {
      continue;
    }

    let xml;
    try {
      xml = await fetchUrl(feed.url);
    } catch (err) {
      console.log(`[rss_collect] ${feed.name}: fetch failed — ${err.message}`);
      continue;
    }

    const items = parseItems(xml);
    if (items.length === 0) {
      console.log(`[rss_collect] ${feed.name}: no items parsed`);
      state[feed.url] = { last_fetched: now, items_found: 0 };
      continue;
    }

    // Filter to new items only
    const newItems = items.filter(i => {
      const key = sha1(i.url);
      return !seen[key];
    });

    if (newItems.length === 0) {
      console.log(`[rss_collect] ${feed.name}: ${items.length} items, all seen`);
      state[feed.url] = { last_fetched: now, items_found: items.length, new_items: 0 };
      continue;
    }

    // Sort by pub_date descending, take top 5
    newItems.sort((a, b) => new Date(b.pub_date) - new Date(a.pub_date));
    const batch = newItems.slice(0, 5);

    // Append to feed_digest.txt
    const digestBlock = batch.map(i => formatDigestEntry(i, feed)).join("");
    appendLine(DIGEST_FILE, `\n── RSS batch: ${feed.name} (${batch.length} new) ─────────`);
    fs.appendFileSync(DIGEST_FILE, digestBlock, "utf-8");

    // Mark as seen
    for (const i of batch) {
      seen[sha1(i.url)] = now;
    }

    // Queue top item from tier 1 sources for browse cycle
    if (feed.tier === 1 && batch[0]) {
      toQueue.push({ url: batch[0].url, title: batch[0].title, feed: feed.name, axis_hint: feed.axis_hint });
    }

    state[feed.url] = { last_fetched: now, items_found: items.length, new_items: batch.length };
    totalNew += batch.length;
    console.log(`[rss_collect] ${feed.name}: ${batch.length} new items appended to digest`);
  }

  // Queue top items to reading_queue (max MAX_QUEUE_URLS, tier 1 sources first)
  const queueItems = toQueue.slice(0, MAX_QUEUE_URLS);
  for (const item of queueItems) {
    appendLine(QUEUE_FILE, JSON.stringify({
      url: item.url,
      source: "rss_collect",
      feed: item.feed,
      title: item.title,
      axis_hint: item.axis_hint,
      queued_at: now,
    }));
    console.log(`[rss_collect] queued for browse: ${item.feed} — ${item.url}`);
  }

  saveJson(SEEN_FILE, seen);
  saveJson(STATE_FILE, state);

  console.log(`[rss_collect] done — ${totalNew} new items across ${FEEDS.length} feeds, ${queueItems.length} queued`);
}

main().catch(err => {
  console.error(`[rss_collect] fatal: ${err.message}`);
  process.exit(0); // non-fatal
});
