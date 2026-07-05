"use strict";
/**
 * runner/lib/content_sources.js — collective content pack for cross-posting.
 *
 * Assembles a single "what Sebastian is seeing and doing right now" pack from all
 * of his signals, so downstream generators (e.g. the LinkedIn draft) can develop
 * a theme that is grounded across surfaces rather than from one feed:
 *
 *   - journal        latest reflective entries (his own synthesis)
 *   - myPosts        recent X posts (his published voice)
 *   - engagements    recent replies/comments/likes (what he chose to engage)
 *   - articles       recent long-form articles (his developed arguments)
 *   - discourse      feed_digest / browse_notes (collected news = web signal)
 *   - xTimeline      LIVE X home timeline (best-effort, via HelmStack)
 *   - linkedinFeed   LIVE LinkedIn feed (best-effort, via HelmStack)
 *   - webSearch      LIVE web search on the top belief axis (best-effort, HelmStack)
 *
 * Every source is best-effort and token-bounded; a missing/unreachable source is
 * simply omitted. Live sources require a HelmStackClient; pass one to include them.
 */

const fs = require("fs");
const path = require("path");
const config = require("./config");

const ROOT = path.resolve(__dirname, "..", "..");
const stripHtml = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const clip = (s, n) => String(s || "").slice(0, n);

// ── File-based sources ────────────────────────────────────────────────────────
function journal(n = 2) {
  try {
    const files = fs.readdirSync(config.JOURNALS_DIR).filter((f) => f.endsWith(".html")).sort();
    return files.slice(-n).map((f) => clip(stripHtml(fs.readFileSync(path.join(config.JOURNALS_DIR, f), "utf-8")), 1200)).join("\n---\n");
  } catch { return ""; }
}

function myPosts(n = 6) {
  try {
    const d = JSON.parse(fs.readFileSync(config.POSTS_LOG_PATH, "utf-8"));
    const posts = (Array.isArray(d) ? d : d.posts || []).filter((p) => ["tweet", "quote", "prediction", "linkedin_post"].includes(p.type));
    return posts.slice(-n).map((p) => `- [${p.type}] ${clip((p.content || "").replace(/\n/g, " "), 200)}`).join("\n");
  } catch { return ""; }
}

function engagements(n = 6) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(config.STATE_DIR, "interactions.json"), "utf-8"));
    const items = (d.interactions || []).filter((e) => e.our_reply || e.type);
    return items.slice(-n).map((e) => {
      if (e.our_reply) return `- replied to @${e.handle}: "${clip(e.our_reply.replace(/\n/g, " "), 160)}"`;
      return `- ${e.type} @${e.handle || "?"}`;
    }).join("\n");
  } catch { return ""; }
}

function articles(n = 2) {
  try {
    const dir = path.join(ROOT, "articles");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    return files.slice(-n).map((f) => `# ${f}\n${clip(fs.readFileSync(path.join(dir, f), "utf-8"), 800)}`).join("\n---\n");
  } catch { return ""; }
}

function discourse() {
  let out = "";
  try { out += clip(fs.readFileSync(config.FEED_DIGEST_PATH, "utf-8"), 1200); } catch {}
  if (!out) { try { out += clip(fs.readFileSync(config.BROWSE_NOTES_PATH, "utf-8"), 1200); } catch {} }
  return out;
}

function topAxisQuery() {
  try {
    const o = JSON.parse(fs.readFileSync(config.ONTOLOGY_PATH, "utf-8"));
    const ax = (o.axes || []).filter((a) => (a.confidence || 0) >= 0.7).sort((a, b) => b.confidence - a.confidence)[0];
    return ax ? ax.label : "narrative manipulation public discourse";
  } catch { return "narrative manipulation public discourse"; }
}

// ── Live sources (HelmStack) ──────────────────────────────────────────────────
async function xTimeline(client) {
  try {
    const { X } = require("../../tools/helmstack-social/src");
    const x = new X(client, { log: () => {} });
    await x.ensureTab();
    if (!(await x.sessionOk())) return "";
    const tl = await x.scrapeTimeline({ limit: 8 });
    return tl.map((t) => `- @${t.handle}: ${clip((t.text || "").replace(/\n/g, " "), 160)}`).join("\n");
  } catch { return ""; }
}

async function linkedinFeed(client) {
  try {
    const { LinkedIn } = require("../../tools/helmstack-social/src");
    const li = new LinkedIn(client, { log: () => {} });
    await li.ensureTab();
    if (!(await li.sessionOk())) return "";
    const feed = await li.scrapeFeed({ limit: 8 });
    return feed.map((p) => `- ${p.author || "?"}: ${clip((p.text || "").replace(/\n/g, " "), 160)}`).join("\n");
  } catch { return ""; }
}

async function webSearch(client, query) {
  try {
    const tab = await client.ensureTab(/duckduckgo\.com/, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    await client.navigate(tab, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    await client.waitReady(tab, { tag: "search" });
    await new Promise((r) => setTimeout(r, 1500));
    const results = await client.evalFn(tab, () => {
      const rows = [].slice.call(document.querySelectorAll(".result__body, .web-result")).slice(0, 6);
      return rows.map((r) => {
        const t = r.querySelector(".result__title, .result__a");
        const s = r.querySelector(".result__snippet");
        return { title: (t ? t.innerText : "").trim(), snippet: (s ? s.innerText : "").trim() };
      }).filter((x) => x.title);
    });
    return (results || []).map((r) => `- ${clip(r.title, 100)} — ${clip(r.snippet, 160)}`).join("\n");
  } catch { return ""; }
}

/**
 * Build the full content pack. Live sources are included only if a client is
 * given and reachable; everything is best-effort.
 * @returns {Promise<{ sources: object, text: string }>}
 */
async function buildContentPack({ client = null } = {}) {
  const query = topAxisQuery();
  const sources = {
    journal: journal(),
    myPosts: myPosts(),
    engagements: engagements(),
    articles: articles(),
    discourse: discourse(),
    xTimeline: client ? await xTimeline(client) : "",
    linkedinFeed: client ? await linkedinFeed(client) : "",
    webSearch: client ? await webSearch(client, query) : "",
  };

  const section = (title, body) => (body ? `── ${title} ──\n${body}\n` : "");
  const text = [
    section("SEBASTIAN'S LATEST JOURNAL", sources.journal),
    section("HIS RECENT X POSTS", sources.myPosts),
    section("HIS RECENT ENGAGEMENTS (what he replied to / engaged)", sources.engagements),
    section("HIS RECENT ARTICLES", sources.articles),
    section("CURRENT DISCOURSE / NEWS (collected)", sources.discourse),
    section("LIVE X TIMELINE (what's on his feed now)", sources.xTimeline),
    section("LIVE LINKEDIN FEED (what's on LinkedIn now)", sources.linkedinFeed),
    section(`LIVE WEB SEARCH — "${query}"`, sources.webSearch),
  ].filter(Boolean).join("\n");

  return { sources, text, query };
}

module.exports = { buildContentPack };
