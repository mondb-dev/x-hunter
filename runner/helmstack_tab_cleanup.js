#!/usr/bin/env node
/**
 * runner/helmstack_tab_cleanup.js — close stray / duplicate HelmStack tabs.
 *
 * Sebastian's engines adopt "any x.com/linkedin/facebook tab" (ensureTab), so
 * leftover tabs from navigation — duplicate FB home tabs, a stray LinkedIn
 * profile a connect-cycle opened, a DuckDuckGo results page, a wedged
 * /compose/post — accumulate and are the root of the "wedged tab" bugs (the
 * engine grabs the wrong one). This keeps ONE canonical tab per core surface
 * (X, LinkedIn, Facebook), closes duplicates, junk (compose/settings/flow/
 * about:blank), and non-core strays. Never closes the fronted (active) tab or
 * the last remaining tab, and preserves auth/tool tabs (Google, Moltbook).
 *
 * Non-fatal, idempotent. Wired into runSocialPipeline (dueForRun) and runnable
 * by hand: node runner/helmstack_tab_cleanup.js [--dry]
 */

"use strict";

const { HelmStackClient } = require("../tools/helmstack-social/src");

const DRY = process.argv.includes("--dry") || process.env.HELMSTACK_DRY_RUN === "1";
const log = (m) => console.log(`[tab_cleanup] ${m}`);

const CORE = [
  { key: "x", re: /^https?:\/\/(www\.)?(x|twitter)\.com/i },
  { key: "linkedin", re: /^https?:\/\/(www\.)?linkedin\.com/i },
  { key: "facebook", re: /^https?:\/\/((www|web|m)\.)?facebook\.com/i },
];
// Non-core tabs to KEEP (auth/session + our own surfaces) rather than treat as strays.
const KEEP_STRAY = /(accounts\.)?google\.com|gmail\.com|moltbook\.com/i;
// URLs that are never a good "keeper" and should be closed even on a core domain.
const JUNK = /\/compose(\/|$|\?)|\/settings(\/|$)|\/i\/flow|\/login(\/|$)|about:blank|^chrome:|^data:/i;

function coreKey(url) {
  for (const c of CORE) if (c.re.test(url)) return c.key;
  return null;
}

// Higher = more canonical → preferred keeper for its domain.
function score(key, url) {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0];
  if (key === "x") return /^\/home\/?$/.test(path) ? 3 : /^\/[A-Za-z0-9_]+\/?$/.test(path) ? 2 : 1;
  if (key === "linkedin") return /^\/feed\/?$/.test(path) ? 3 : /^\/in\//.test(path) ? 2 : 1;
  if (key === "facebook") return path === "" || path === "/" ? 3 : 1;
  return 0;
}

(async () => {
  const c = new HelmStackClient();
  let tabs;
  try { tabs = await c.listTabs(); }
  catch (e) { log(`could not reach HelmStack: ${e.message}`); process.exit(0); }
  if (!Array.isArray(tabs) || tabs.length <= 1) { log(`${tabs?.length || 0} tab(s) — nothing to clean`); process.exit(0); }

  // Pick the best keeper per core domain (highest score, not junk).
  const keepers = {}; // key -> {id, score}
  for (const t of tabs) {
    const url = t.url || "";
    const key = coreKey(url);
    if (!key || JUNK.test(url)) continue;
    const s = score(key, url);
    if (!keepers[key] || s > keepers[key].score) keepers[key] = { id: t.id, score: s };
  }

  const toClose = [];
  for (const t of tabs) {
    const url = t.url || "";
    if (t.isActive) continue;                 // never close the fronted tab
    if (KEEP_STRAY.test(url)) continue;        // keep auth/Moltbook tabs
    const key = coreKey(url);
    const isKeeper = key && keepers[key] && keepers[key].id === t.id;
    if (isKeeper) continue;                    // the one canonical tab for its surface
    // Everything else: junk, duplicate core tabs, or non-core strays (search, etc.)
    toClose.push(t);
  }

  // Safety: never close every tab.
  while (toClose.length >= tabs.length) toClose.pop();

  if (!toClose.length) { log(`${tabs.length} tab(s), all canonical — nothing to close`); process.exit(0); }

  log(`${tabs.length} tab(s); closing ${toClose.length}${DRY ? " [dry-run]" : ""}:`);
  for (const t of toClose) {
    const why = JUNK.test(t.url || "") ? "junk" : coreKey(t.url || "") ? "duplicate" : "stray";
    log(`  ${DRY ? "would close" : "close"} [${why}] ${(t.url || "").slice(0, 60)}`);
    if (!DRY) { try { await c.closeTab(t.id); } catch (e) { log(`    close failed: ${e.message}`); } }
  }
  log(`done — ${DRY ? 0 : toClose.length} closed`);
  process.exit(0);
})().catch((e) => { log(`fatal: ${e.message}`); process.exit(0); });
