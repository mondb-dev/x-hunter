#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { generateHeroArt } = require("./landmark/art");
const { renderCardSvg } = require("./landmark/render");
const { LANDMARK_TIERS } = require("./landmark/config");

const ROOT = path.resolve(__dirname, "..");
const ARTICLES_DIR = path.join(ROOT, "articles");
const LANDMARKS_DIR = path.join(ROOT, "landmarks");
const ARTICLE_STATE = path.join(ROOT, "state", "article_state.json");
const OUTPUT_DIR = path.join(ROOT, "landmarks", "random_headlines");

const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "that",
  "this", "have", "will", "what", "when", "your", "after", "before",
  "field", "report", "belief", "checkpoint", "sebastian", "hunter",
]);

function parseArgs(argv) {
  const opts = {
    sources: [],
    contains: [],
    tierKey: "tier_2",
    limit: 12,
    listOnly: false,
    dryRun: false,
    headline: null,
    outputPath: null,
    style: "pixel_art",
    card: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source") opts.sources.push(String(argv[++i] || ""));
    else if (arg === "--contains") opts.contains.push(String(argv[++i] || ""));
    else if (arg === "--tier") opts.tierKey = String(argv[++i] || opts.tierKey);
    else if (arg === "--limit") opts.limit = Math.max(1, Number(argv[++i] || opts.limit) || opts.limit);
    else if (arg === "--headline") opts.headline = String(argv[++i] || "");
    else if (arg === "--output") opts.outputPath = String(argv[++i] || "");
    else if (arg === "--style") opts.style = String(argv[++i] || opts.style);
    else if (arg === "--card") opts.card = true;
    else if (arg === "--no-card") opts.card = false;
    else if (arg === "--list") opts.listOnly = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown arg: ${arg}`);
  }

  if (!LANDMARK_TIERS[opts.tierKey]) {
    throw new Error(`Unknown tier: ${opts.tierKey}`);
  }

  return opts;
}

function usage() {
  return [
    "Usage: node runner/random_headline_art.js [options]",
    "",
    "Options:",
    "  --source <article|landmark|state>   limit candidate sources (repeatable)",
    "  --contains <term>                    filter headlines containing term (repeatable)",
    "  --tier <tier_2|tier_1|special_vocation|special_prediction>",
    "  --limit <n>                          consider only the newest n candidates (default: 12)",
    "  --headline <text>                    bypass random selection and use this headline directly",
    "  --style <pixel_art|editorial>        art direction (default: pixel_art)",
    "  --card / --no-card                   write SVG card with text (default: on)",
    "  --list                               print candidate headlines only",
    "  --dry-run                            print selected headline + prompt, no image generation",
    "  --output <path>                      save PNG to explicit path",
  ].join("\n");
}

function loadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function readDirSorted(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function parseArticleTitle(file) {
  const raw = fs.readFileSync(file, "utf-8");
  const frontmatterTitle = raw.match(/^title:\s*"(.+?)"\s*$/m)?.[1]?.trim();
  const headingTitle = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const date = raw.match(/^date:\s*"(.+?)"\s*$/m)?.[1]?.trim() || path.basename(file, path.extname(file));

  return {
    headline: frontmatterTitle || headingTitle || path.basename(file),
    date,
  };
}

function collectArticleCandidates() {
  return readDirSorted(ARTICLES_DIR)
    .filter(file => file.endsWith(".md"))
    .map(file => {
      const fullPath = path.join(ARTICLES_DIR, file);
      const parsed = parseArticleTitle(fullPath);
      return {
        source: "article",
        id: `article:${file}`,
        headline: parsed.headline,
        date: parsed.date,
        topKeywords: extractKeywords(parsed.headline),
        signalCount: 4,
        landmarkTierKey: "tier_2",
      };
    });
}

function collectLandmarkCandidates() {
  return readDirSorted(LANDMARKS_DIR)
    .filter(name => name.startsWith("landmark_"))
    .map(name => path.join(LANDMARKS_DIR, name, "event.json"))
    .filter(file => fs.existsSync(file))
    .map(file => {
      const event = loadJson(file, {});
      return {
        source: "landmark",
        id: `landmark:${path.basename(path.dirname(file))}`,
        headline: event.headline || path.basename(path.dirname(file)),
        date: event.date || event.dateStr || path.basename(path.dirname(file)),
        topKeywords: Array.isArray(event.topKeywords) && event.topKeywords.length
          ? event.topKeywords
          : extractKeywords(event.headline || ""),
        signalCount: Number(event.signalCount || 4),
        landmarkTierKey: event.landmarkTierKey || "tier_2",
      };
    });
}

function collectStateCandidate() {
  const state = loadJson(ARTICLE_STATE, null);
  if (!state?.title) return [];
  return [{
    source: "state",
    id: "state:article_state",
    headline: state.title,
    date: state.last_written_at || "state",
    topKeywords: extractKeywords(state.title),
    signalCount: 4,
    landmarkTierKey: "tier_2",
  }];
}

function extractKeywords(headline) {
  return Array.from(new Set(
    String(headline || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s'-]/g, " ")
      .split(/\s+/)
      .filter(word => word.length > 3 && !STOP.has(word))
  )).slice(0, 5);
}

function candidateTimeValue(candidate) {
  const stamp = Date.parse(candidate.date);
  return Number.isNaN(stamp) ? 0 : stamp;
}

function collectCandidates(opts) {
  if (opts.headline) {
    return [{
      source: "manual",
      id: "manual:headline",
      headline: opts.headline,
      date: new Date().toISOString(),
      topKeywords: extractKeywords(opts.headline),
      signalCount: 4,
      landmarkTierKey: opts.tierKey,
    }];
  }

  const requestedSources = new Set((opts.sources.length ? opts.sources : ["article", "landmark", "state"]).map(String));
  let candidates = [];

  if (requestedSources.has("article")) candidates = candidates.concat(collectArticleCandidates());
  if (requestedSources.has("landmark")) candidates = candidates.concat(collectLandmarkCandidates());
  if (requestedSources.has("state")) candidates = candidates.concat(collectStateCandidate());

  const deduped = [];
  const seenHeadlines = new Set();

  for (const candidate of candidates
    .filter(candidate => candidate.headline)
    .sort((a, b) => candidateTimeValue(b) - candidateTimeValue(a))) {
    const key = candidate.headline.trim().toLowerCase();
    if (seenHeadlines.has(key)) continue;
    seenHeadlines.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function applyFilters(candidates, opts) {
  let filtered = candidates.slice(0, opts.limit);

  for (const term of opts.contains) {
    const needle = String(term).toLowerCase();
    filtered = filtered.filter(candidate => candidate.headline.toLowerCase().includes(needle));
  }

  return filtered;
}

function chooseRandom(candidates) {
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function buildEvent(candidate, tierKey) {
  return {
    headline: candidate.headline,
    topKeywords: candidate.topKeywords,
    signalCount: candidate.signalCount || 4,
    landmarkTierKey: tierKey,
    date: candidate.date,
    signals: candidate.signals || {},
    stats: candidate.stats || {
      crossClusterTopics: (candidate.topKeywords || []).map(keyword => ({ keyword })),
      axesImpacted: [],
    },
  };
}

function ensureOutputPath(headline, outputPath) {
  if (outputPath) return path.resolve(outputPath);
  const slug = String(headline || "headline")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "headline";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(OUTPUT_DIR, `${stamp}-${slug}.png`);
}

function writeManifest(imagePath, payload) {
  const manifestPath = imagePath.replace(/\.png$/i, ".json");
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
  return manifestPath;
}

function writeSvgCard(imagePath, event, selected, artBuffer, opts) {
  const svgPath = imagePath.replace(/\.png$/i, ".svg");
  const svg = renderCardSvg(
    event,
    { headline: selected.headline, lead: selected.headline },
    artBuffer,
    {
      tierKey: opts.tierKey,
      editionSupply: LANDMARK_TIERS[opts.tierKey].editionSupply,
      landmarkNumber: 0,
      editionNumber: 1,
    }
  );
  fs.writeFileSync(svgPath, svg);
  return svgPath;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }

  const candidates = applyFilters(collectCandidates(opts), opts);
  if (candidates.length === 0) {
    throw new Error("No headline candidates matched the requested criteria");
  }

  if (opts.listOnly) {
    console.log(JSON.stringify(candidates.map(candidate => ({
      source: candidate.source,
      date: candidate.date,
      headline: candidate.headline,
    })), null, 2));
    return;
  }

  const selected = chooseRandom(candidates);
  const event = buildEvent(selected, opts.tierKey);
  event.artStyle = opts.style;

  if (opts.dryRun) {
    const { buildArtPrompt } = require("./landmark/art");
    console.log(JSON.stringify({
      selected,
      tier: opts.tierKey,
      style: opts.style,
      prompt: buildArtPrompt(event),
    }, null, 2));
    return;
  }

  const outputPath = ensureOutputPath(selected.headline, opts.outputPath);
  const result = await generateHeroArt(event, { outputPath });
  const cardSvgPath = opts.card ? writeSvgCard(outputPath, event, selected, result.buffer, opts) : null;
  const manifestPath = writeManifest(outputPath, {
    generated_at: new Date().toISOString(),
    source: selected.source,
    selected_headline: selected.headline,
    date: selected.date,
    tier: opts.tierKey,
    style: opts.style,
    prompt: result.prompt,
    topKeywords: selected.topKeywords,
    card_svg_path: cardSvgPath,
  });

  console.log(JSON.stringify({
    outputPath,
    cardSvgPath,
    manifestPath,
    headline: selected.headline,
    source: selected.source,
    tier: opts.tierKey,
    style: opts.style,
  }, null, 2));
}

main().catch(err => {
  console.error(`[random_headline_art] ${err.message}`);
  process.exit(1);
});
