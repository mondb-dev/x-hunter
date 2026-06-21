#!/usr/bin/env node
/**
 * runner/external_source_discovery.js — build a deterministic external-source registry
 *
 * Discovers external URLs already present in Sebastian's state and writing,
 * normalizes them to domains, and computes rule-based profiles plus observed
 * outcome metrics. No LLM is used.
 *
 * Output: state/external_sources.json
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("./lib/config");
const { loadScraperDb } = require("./lib/db_backend");
const db = loadScraperDb();
const {
  canonicalDomain,
  extractUrls,
  normalizeUrl,
} = require("./lib/url_utils");

const ROOT = config.PROJECT_ROOT;
const STATE_DIR = config.STATE_DIR;
const OUTPUT = config.EXTERNAL_SOURCES_PATH;

const ONTOLOGY = config.ONTOLOGY_PATH;
const CLAIMS = config.CLAIM_TRACKER_PATH;
const POSTS = config.POSTS_LOG_PATH;
const JOURNALS_DIR = config.JOURNALS_DIR;
const ARTICLES_DIR = path.join(ROOT, "articles");
const QUEUE_FILE = path.join(STATE_DIR, "reading_queue.jsonl");
const PREFETCH_SOURCE = config.PREFETCH_SOURCE_PATH;
const FEED_BUFFER = path.join(STATE_DIR, "feed_buffer.jsonl");

const DOMAIN_CLASSIFIERS = [
  { kind: "official", re: /(^|\.)gov(\.[a-z]{2})?$|(^|\.)mil$|whitehouse\.gov$|state\.gov$|europa\.eu$|un\.org$/i },
  { kind: "court_archive", re: /courtlistener\.com$|supremecourt\.gov$|lawphil\.net$|congress\.gov$/i },
  { kind: "academic", re: /arxiv\.org$|nature\.com$|science\.org$|ssrn\.com$|semanticscholar\.org$|jstor\.org$|doi\.org$|ncbi\.nlm\.nih\.gov$|pubmed\.ncbi\.nlm\.nih\.gov$/i },
  { kind: "news", re: /reuters\.com$|apnews\.com$|bbc\.(co\.uk|com)$|nytimes\.com$|washingtonpost\.com$|theguardian\.com$|propublica\.org$|aljazeera\.com$/i },
  { kind: "reference", re: /wikipedia\.org$|archive\.org$/i },
  { kind: "forum", re: /reddit\.com$|news\.ycombinator\.com$/i },
  { kind: "newsletter_blog", re: /substack\.com$|medium\.com$/i },
];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function classifyDomain(domain) {
  for (const entry of DOMAIN_CLASSIFIERS) {
    if (entry.re.test(domain)) return entry.kind;
  }
  return "unknown";
}

function inferEntity(domain) {
  const label = domain
    .replace(/\.(com|org|net|gov|edu|co\.uk|eu)$/i, "")
    .split(".")
    .slice(-2)
    .join(" ");
  return label.replace(/\b\w/g, c => c.toUpperCase());
}

function scoreProvenance(kind, features) {
  let score = 0.45;
  const basis = [];

  switch (kind) {
    case "official":
      score = 0.95;
      basis.push("official_domain_pattern");
      break;
    case "court_archive":
      score = 0.92;
      basis.push("court_or_archive_pattern");
      break;
    case "academic":
      score = 0.9;
      basis.push("academic_domain_pattern");
      break;
    case "news":
      score = 0.72;
      basis.push("newsroom_domain_pattern");
      break;
    case "reference":
      score = 0.62;
      basis.push("reference_archive_pattern");
      break;
    case "forum":
      score = 0.3;
      basis.push("community_forum_pattern");
      break;
    case "newsletter_blog":
      score = 0.42;
      basis.push("newsletter_blog_pattern");
      break;
    default:
      basis.push("unknown_domain_pattern");
  }

  if (features.has_article_paths) {
    score += 0.03;
    basis.push("article_path_seen");
  }
  if (features.has_search_paths) {
    score -= 0.08;
    basis.push("search_results_seen");
  }
  if (features.has_doi_paths) {
    score += 0.03;
    basis.push("doi_or_identifier_path_seen");
  }

  return { score: clamp(score), basis };
}

function scoreBreadth(metrics) {
  const score = clamp(
    Math.min(metrics.distinct_urls / 12, 1) * 0.35 +
    Math.min(metrics.distinct_axes_count / 6, 1) * 0.35 +
    Math.min(metrics.origin_types_count / 5, 1) * 0.3
  );
  const basis = [
    `distinct_urls:${metrics.distinct_urls}`,
    `distinct_axes:${metrics.distinct_axes_count}`,
    `origin_types:${metrics.origin_types_count}`,
  ];
  return { score, basis };
}

function scoreTrackRecord(claims) {
  const resolved = claims.supported + claims.refuted + claims.contested;
  if (!resolved) {
    return { score: null, basis: ["no_resolved_claims_observed"] };
  }

  const score = clamp((claims.supported + (claims.contested * 0.5)) / resolved);
  const basis = [
    `supported:${claims.supported}`,
    `refuted:${claims.refuted}`,
    `contested:${claims.contested}`,
  ];
  return { score, basis };
}

function scoreOverall(provenance, breadth, trackRecord, observations) {
  let weighted = (provenance.score * 0.55) + (breadth.score * 0.25);
  let weight = 0.8;
  const basis = [...provenance.basis, ...breadth.basis];

  if (trackRecord.score !== null) {
    weighted += trackRecord.score * 0.2;
    weight += 0.2;
    basis.push(...trackRecord.basis);
  } else {
    basis.push("track_record_unavailable");
  }

  const score = clamp(weighted / weight);
  const confidence = clamp(
    Math.min(observations / 20, 1) * 0.45 +
    Math.min((trackRecord.score === null ? 0 : 1), 1) * 0.25 +
    Math.min(breadth.score, 1) * 0.3
  );
  return { score, confidence, basis };
}

function clamp(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function updateSeenBounds(bucket, ts) {
  if (!ts) return;
  if (!bucket.first_seen_at || ts < bucket.first_seen_at) bucket.first_seen_at = ts;
  if (!bucket.last_seen_at || ts > bucket.last_seen_at) bucket.last_seen_at = ts;
}

function ensureBucket(map, normalized, entity) {
  if (!map.has(normalized.domain)) {
    map.set(normalized.domain, {
      domain: normalized.domain,
      entity: entity || inferEntity(normalized.domain),
      kind: classifyDomain(normalized.domain),
      first_seen_at: null,
      last_seen_at: null,
      urls: new Set(),
      examples: [],
      origins: Object.create(null),
      referring_accounts: new Set(),
      axes: new Set(),
      claims: { total: 0, supported: 0, refuted: 0, contested: 0, unverified: 0 },
      structural_features: {
        has_search_paths: false,
        has_article_paths: false,
        has_doi_paths: false,
      },
    });
  }
  return map.get(normalized.domain);
}

function noteObservation(bucket, normalized, origin, ts, axisId, referrer) {
  bucket.urls.add(normalized.url);
  bucket.origins[origin] = (bucket.origins[origin] || 0) + 1;
  if (referrer) bucket.referring_accounts.add(String(referrer).toLowerCase());
  if (axisId) bucket.axes.add(axisId);
  if (bucket.examples.length < 5 && !bucket.examples.includes(normalized.url)) {
    bucket.examples.push(normalized.url);
  }
  if (/\/search|[?&]q=|[?&]query=/.test(`${normalized.pathname}${normalized.search}`)) {
    bucket.structural_features.has_search_paths = true;
  }
  if (/\/20\d{2}\//.test(normalized.pathname) || /\/\d{4}-\d{2}-\d{2}/.test(normalized.pathname) || /\/article\//.test(normalized.pathname)) {
    bucket.structural_features.has_article_paths = true;
  }
  if (/doi|\/abs\/|\/paper\/|\/status\//i.test(normalized.pathname)) {
    bucket.structural_features.has_doi_paths = true;
  }
  updateSeenBounds(bucket, ts);
}

function collectFromOntology(map) {
  const onto = readJson(ONTOLOGY, { axes: [] });
  for (const axis of onto.axes || []) {
    for (const evidence of axis.evidence_log || []) {
      for (const rawUrl of extractUrls(evidence.source || "")) {
        const normalized = normalizeUrl(rawUrl);
        if (!normalized) continue;
        const bucket = ensureBucket(map, normalized);
        noteObservation(bucket, normalized, "ontology_evidence", evidence.timestamp, axis.id, null);
      }
    }
  }
}

async function collectFromClaims(map) {
  const tracker = readJson(CLAIMS, { claims: [] });
  for (const claim of tracker.claims || []) {
    let claimUrl = claim.cited_url || claim.source_url;
    if (!claim.cited_url && /\/status\/(\d+)/.test(String(claim.source_post_url || claim.source_url || ""))) {
      const tweetId = String(claim.source_post_url || claim.source_url).match(/\/status\/(\d+)/)?.[1];
      const post = tweetId ? await db.getPostById(tweetId) : null;
      if (post && Array.isArray(post.external_urls) && post.external_urls.length > 0) {
        claimUrl = post.external_urls[0];
      }
    }

    const normalized = normalizeUrl(claimUrl);
    if (!normalized) continue;
    const bucket = ensureBucket(map, normalized);
    noteObservation(bucket, normalized, "claim_tracker", claim.updated_at || claim.created_at, claim.related_axis_id, null);
    bucket.claims.total += 1;
    switch (claim.status) {
      case "supported":
        bucket.claims.supported += 1;
        break;
      case "refuted":
        bucket.claims.refuted += 1;
        break;
      case "contested":
        bucket.claims.contested += 1;
        break;
      default:
        bucket.claims.unverified += 1;
    }
  }
}

function collectFromPosts(map) {
  const posts = readJson(POSTS, { posts: [] });
  for (const post of posts.posts || []) {
    const normalized = normalizeUrl(post.source_url);
    if (!normalized) continue;
    const bucket = ensureBucket(map, normalized);
    noteObservation(bucket, normalized, "posts_log", post.posted_at || null, null, null);
  }
}

function collectFromQueue(map) {
  for (const entry of readJsonl(QUEUE_FILE)) {
    const normalized = normalizeUrl(entry.url);
    if (!normalized) continue;
    const bucket = ensureBucket(map, normalized);
    noteObservation(
      bucket,
      normalized,
      entry.from_user === "conviction_source" ? "reading_queue_conviction" : "reading_queue",
      entry.added_at || entry.consumed_at || null,
      null,
      entry.from_user && !entry.from_user.includes("source") ? entry.from_user : null
    );
  }
}

function collectFromDir(map, dirPath, origin) {
  if (!fs.existsSync(dirPath)) return;
  for (const file of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, file);
    let content = "";
    try {
      content = fs.readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    const ts = new Date(fs.statSync(full).mtimeMs).toISOString();
    for (const rawUrl of extractUrls(content)) {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) continue;
      const bucket = ensureBucket(map, normalized);
      noteObservation(bucket, normalized, origin, ts, null, null);
    }
  }
}

function collectFromPrefetch(map) {
  if (!fs.existsSync(PREFETCH_SOURCE)) return;
  const lines = fs.readFileSync(PREFETCH_SOURCE, "utf-8").split("\n").filter(Boolean);
  if (lines.length < 2) return;
  const normalized = normalizeUrl(lines[1].trim());
  if (!normalized) return;
  const bucket = ensureBucket(map, normalized);
  noteObservation(bucket, normalized, "prefetch", new Date().toISOString(), null, null);
}

function collectFromFeedBuffer(map) {
  for (const item of readJsonl(FEED_BUFFER)) {
    const ts = item.ts_iso || null;
    const referrer = item.u || null;

    const urls = Array.isArray(item.external_urls) && item.external_urls.length > 0
      ? item.external_urls
      : extractUrls(item.text || "");
    for (const rawUrl of urls) {
      const normalized = normalizeUrl(rawUrl);
      if (!normalized) continue;
      const bucket = ensureBucket(map, normalized);
      noteObservation(bucket, normalized, "feed_buffer", ts, null, referrer);
    }

    for (const reply of item.top_replies || []) {
      const replyUrls = Array.isArray(reply.external_urls) && reply.external_urls.length > 0
        ? reply.external_urls
        : extractUrls(reply.text || "");
      for (const rawUrl of replyUrls) {
        const normalized = normalizeUrl(rawUrl);
        if (!normalized) continue;
        const bucket = ensureBucket(map, normalized);
        noteObservation(bucket, normalized, "feed_buffer_reply", ts, null, reply.u || null);
      }
    }
  }
}

function scoreCorroboration(bucket) {
  const accountCount = bucket.referring_accounts.size;
  const originTypes = Object.keys(bucket.origins).length;
  const score = clamp(
    Math.min(accountCount / 6, 1) * 0.65 +
    Math.min(originTypes / 4, 1) * 0.35
  );
  const basis = [
    `referring_accounts:${accountCount}`,
    `origin_types:${originTypes}`,
  ];
  return { score, basis };
}

function buildOutput(map, previousByDomain, previousRegistry = {}) {
  const sources = [...map.values()].map(bucket => {
    const previous = previousByDomain.get(bucket.domain) || null;
    const originTypes = Object.keys(bucket.origins).length;
    const metrics = {
      distinct_urls: bucket.urls.size,
      distinct_axes_count: bucket.axes.size,
      origin_types_count: originTypes,
    };
    const provenance = scoreProvenance(bucket.kind, bucket.structural_features);
    const breadth = scoreBreadth(metrics);
    const corroboration = scoreCorroboration(bucket);
    const trackRecord = scoreTrackRecord(bucket.claims);
    const overall = scoreOverall(
      provenance,
      { score: clamp((breadth.score * 0.7) + (corroboration.score * 0.3)), basis: [...breadth.basis, ...corroboration.basis] },
      trackRecord,
      bucket.urls.size + bucket.referring_accounts.size
    );

    return {
      domain: bucket.domain,
      entity: bucket.entity,
      kind: bucket.kind,
      first_seen_at: bucket.first_seen_at,
      last_seen_at: bucket.last_seen_at,
      discovery: {
        distinct_urls: bucket.urls.size,
        example_urls: bucket.examples,
        origin_counts: bucket.origins,
        distinct_referring_accounts: bucket.referring_accounts.size,
        sample_referring_accounts: [...bucket.referring_accounts].sort().slice(0, 10),
        distinct_axes: [...bucket.axes].sort(),
      },
      claims: {
        total: bucket.claims.total,
        supported: bucket.claims.supported,
        refuted: bucket.claims.refuted,
        contested: bucket.claims.contested,
        unverified: bucket.claims.unverified,
        resolved_count: bucket.claims.supported + bucket.claims.refuted + bucket.claims.contested,
      },
      structural_features: bucket.structural_features,
      ratings: {
        provenance,
        breadth,
        corroboration,
        track_record: trackRecord,
        ...(previous?.ratings?.profile ? { profile: previous.ratings.profile } : {}),
        overall: {
          score: overall.score,
          confidence: overall.confidence,
          method: "mechanical_v1",
          basis: overall.basis,
        },
      },
      ...(previous?.profile ? { profile: previous.profile } : {}),
    };
  }).sort((a, b) => {
    const scoreDelta = (b.ratings.overall.score || 0) - (a.ratings.overall.score || 0);
    if (scoreDelta !== 0) return scoreDelta;
    return (b.discovery.distinct_urls || 0) - (a.discovery.distinct_urls || 0);
  });

  const hasProfiles = sources.some(source => source.profile || source.ratings?.profile);
  return {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    method: hasProfiles ? "mechanical_registry_v1" : "discovery_only_mechanical",
    ...(previousRegistry.profiled_at ? { profiled_at: previousRegistry.profiled_at } : {}),
    sources,
  };
}

async function main() {
  const previousRegistry = readJson(OUTPUT, { sources: [] });
  const previousByDomain = new Map((previousRegistry.sources || []).map(source => [source.domain, source]));
  const map = new Map();
  collectFromOntology(map);
  await collectFromClaims(map);
  collectFromPosts(map);
  collectFromQueue(map);
  collectFromFeedBuffer(map);
  collectFromDir(map, JOURNALS_DIR, "journals");
  collectFromDir(map, ARTICLES_DIR, "articles");
  collectFromPrefetch(map);

  const output = buildOutput(map, previousByDomain, previousRegistry);
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`[external_source_discovery] wrote ${output.sources.length} sources`);
}

main().catch(err => {
  console.error(`[external_source_discovery] error: ${err.message}`);
  process.exit(0);
});
