"use strict";
/**
 * runner/lib/post_x_helmstack.js — X posting via the HelmStack browser substrate
 *
 * HelmStack backend for post_tweet.js / post_quote.js (selected with
 * POST_BACKEND=helmstack). Mirrors the legacy CDP flows: same draft files,
 * same result/attempt files, same posts_log entries, same exit semantics —
 * post.js and the orchestrator are unaware which backend ran.
 *
 * Text insertion uses document.execCommand("insertText") in-page, which works
 * on HelmStack's Chromium (Electron 35 / Chromium 134). There is no keyboard
 * fallback over the HTTP API: on exact-match failure after one retry the
 * attempt aborts and the draft stays for watchdog retry.
 *
 * HELMSTACK_DRY_RUN=1 runs everything up to (not including) the Post click,
 * then clears the composer and exits 0.
 */

const fs = require("fs");
const hs = require("./helmstack");
const { logTweet, logQuote } = require("../posts_log");
const {
  HANDLE,
  clearFile,
  isConfirmedStatusUrl,
  writeAttempt,
  writeResult,
} = require("../post_result");
const voiceFilter = require("./voice_filter");

const COMPOSE_BOX = '[data-testid="tweetTextarea_0"]';
const POST_BUTTON = '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]';
const DRY_RUN = process.env.HELMSTACK_DRY_RUN === "1";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));
const normalizeText = (v) => String(v || "").replace(/\s+/g, " ").trim().toLowerCase();

// ── In-page snippets (serialised via hs.evalFn) ─────────────────────────────

function pageClickFocus(sel) {
  const el = document.querySelector(sel);
  if (el) { el.click(); el.focus(); }
  return !!el;
}

function pageComposerText(sel) {
  const el = document.querySelector(sel);
  return el ? el.innerText.trim() : "";
}

function pageInsertText(text, sel) {
  const el = document.querySelector(sel);
  if (!el) return false;
  el.focus();
  document.execCommand("selectAll");
  document.execCommand("delete");
  document.execCommand("insertText", false, text);
  return true;
}

function pageToast() {
  const toasts = Array.from(document.querySelectorAll('[data-testid="toast"], [role="alert"]'));
  return toasts.map(t => t.innerText).find(t => /automated|spam/i.test(t)) || null;
}

function pageScanProfile({ expectedNeedle, handle }) {
  const norm = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const articles = Array.from(document.querySelectorAll("article")).slice(0, 15);
  const debug = { articleCount: articles.length, firstArticlePreview: "" };
  if (articles.length > 0) {
    debug.firstArticlePreview = norm(articles[0].innerText).slice(0, 80);
  }
  for (const article of articles) {
    const text = norm(article.innerText);
    if (!text || !text.includes(expectedNeedle)) continue;
    const links = Array.from(article.querySelectorAll('a[href*="/status/"]'))
      .map(a => a.getAttribute("href") || "");
    const href = links.find(h =>
      new RegExp(`/${handle}/status/\\d+`, "i").test(h) &&
      !/\/analytics/i.test(h)
    );
    if (href) return { url: `https://x.com${href.split("?")[0]}`, debug };
  }
  return { url: null, debug };
}

// ── Shared steps ────────────────────────────────────────────────────────────

async function confirmFromProfile(tabId, tag, expectedText, attempts = 6, delayMs = 4_000) {
  const needle = normalizeText(expectedText).slice(0, 50);
  console.log(`[${tag}] confirmFromProfile: looking for "${needle.slice(0, 40)}..." (${attempts} attempts, ${delayMs}ms delay)`);
  await hs.navigate(tabId, `https://x.com/${HANDLE}`);
  await hs.waitReady(tabId, { tag });
  await sleep(3_000);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await sleep(delayMs);
    const result = await hs.evalFn(tabId, pageScanProfile, { expectedNeedle: needle, handle: HANDLE });
    if (result && isConfirmedStatusUrl(result.url)) {
      console.log(`[${tag}] profile confirmed on attempt ${attempt}: ${result.url}`);
      return result.url;
    }
    if (attempt < attempts) {
      const dbg = (result && result.debug) || { articleCount: 0, firstArticlePreview: "" };
      console.log(`[${tag}] profile confirmation miss ${attempt}/${attempts} (${dbg.articleCount} articles, first: "${dbg.firstArticlePreview}") — reloading...`);
      if (attempt % 2 === 0) {
        await hs.evaluate(tabId, "location.reload()").catch(() => {});
        await hs.waitReady(tabId, { tag }).catch(() => {});
        await sleep(2_000);
      }
    }
  }
  return null;
}

/**
 * Insert text into the X composer and verify it matches EXACTLY.
 *
 * Attempt 1 uses HelmStack's insert-text endpoint (CDP Input.insertText —
 * browser-level events the React composer state tracks). Attempt 2 falls back
 * to in-page execCommand for older HelmStack builds without the endpoint.
 * Returns true on verified insert.
 */
async function insertVerified(tabId, tag, text) {
  await hs.evalFn(tabId, pageClickFocus, COMPOSE_BOX);
  await humanDelay(2_000, 4_000); // let the React editor initialise before insert

  for (let attempt = 1; attempt <= 2; attempt++) {
    // Clear any leftover draft so text is not spliced into stale content
    await hs.evalFn(tabId, function (sel) {
      const el = document.querySelector(sel);
      if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      return !!el;
    }, COMPOSE_BOX);
    await sleep(400);
    // Re-focus after the clear: Input.insertText targets the focused element,
    // and selectAll/delete can leave the editor without a live selection
    await hs.evalFn(tabId, pageClickFocus, COMPOSE_BOX);
    await sleep(300);

    if (attempt === 1) {
      try {
        await hs.insertText(tabId, text);
      } catch (err) {
        console.log(`[${tag}] insert-text endpoint unavailable (${err.message}) — using execCommand`);
        await hs.evalFn(tabId, pageInsertText, text, COMPOSE_BOX);
      }
    } else {
      await hs.evalFn(tabId, pageInsertText, text, COMPOSE_BOX);
    }
    await sleep(1_500);

    const inserted = await hs.evalFn(tabId, pageComposerText, COMPOSE_BOX);
    console.log(`[${tag}] text verification (attempt ${attempt}): ${inserted.length}/${text.length} chars`);
    if (inserted === text.trim()) return true;
    if (attempt === 1) {
      console.log(`[${tag}] text mismatch — clearing and retrying`);
      await hs.evalFn(tabId, pageClickFocus, COMPOSE_BOX);
      await sleep(1_000);
    }
  }
  return false;
}

async function connectAndGetTab(tag, attemptFile, kind, cycle) {
  try {
    await hs.health();
    const tabId = await hs.ensureXTab();
    return tabId;
  } catch (err) {
    console.error(`[${tag}] could not reach HelmStack: ${err.message}`);
    writeAttempt(attemptFile, {
      kind,
      outcome: "failed",
      reason: "helmstack_connect_failed",
      error: err.message,
      cycle,
    });
    return null;
  }
}

/** If HelmStack queued an approval for this action, surface it in the log. */
async function reportPendingApprovals(tag) {
  try {
    const pending = await hs.approvals();
    const items = Array.isArray(pending) ? pending : (pending.approvals || []);
    if (items.length > 0) {
      console.log(`[${tag}] NOTE: ${items.length} HelmStack approval(s) pending — check the approvals panel`);
    }
  } catch { /* approvals are informational only */ }
}

// ── runTweet ────────────────────────────────────────────────────────────────

async function runTweet({ draftFile, resultFile, attemptFile, cycle }) {
  const tag = "post_tweet.hs";
  clearFile(resultFile);

  if (!fs.existsSync(draftFile)) {
    console.error(`[${tag}] no tweet_draft.txt found — skipping`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "draft_missing", cycle });
    return 1;
  }
  const tweetText = fs.readFileSync(draftFile, "utf-8").trim();
  if (!tweetText) {
    console.error(`[${tag}] tweet_draft.txt is empty — skipping`);
    writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "draft_empty", cycle });
    return 1;
  }
  console.log(`[${tag}] posting (${tweetText.length} chars): ${tweetText.slice(0, 80)}...`);

  const tabId = await connectAndGetTab(tag, attemptFile, "tweet", cycle);
  if (!tabId) return 1;

  try {
    console.log(`[${tag}] navigating to x.com/home...`);
    await hs.navigate(tabId, "https://x.com/home");
    await hs.waitReady(tabId, { tag });
    await humanDelay(2_500, 5_000);

    await hs.pollFn(tabId, "compose box",
      () => !!document.querySelector('[data-testid="tweetTextarea_0"]'),
      { attempts: 15, interval: 1_000, tag });
    await humanDelay(500, 1_500);

    if (!(await insertVerified(tabId, tag, tweetText))) {
      console.error(`[${tag}] text insertion failed after retry — aborting`);
      writeAttempt(attemptFile, { kind: "tweet", outcome: "failed", reason: "text_insert_failed", cycle });
      return 1;
    }

    await hs.pollFn(tabId, "post button enabled", () => {
      const el = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
      return el != null && el.getAttribute("aria-disabled") !== "true";
    }, { attempts: 15, interval: 1_000, tag });

    const prePostToast = await hs.evalFn(tabId, pageToast).catch(() => null);
    if (prePostToast) {
      console.error(`[${tag}] anti-automation toast detected before posting: ${prePostToast}`);
      writeAttempt(attemptFile, {
        kind: "tweet", outcome: "failed", reason: "anti_automation_block",
        stage: "before_post_click", toast: prePostToast, cycle,
      });
      return 1;
    }

    if (DRY_RUN) {
      console.log(`[${tag}] DRY RUN — composer verified, not clicking Post. Clearing composer...`);
      await hs.evalFn(tabId, function (sel) {
        const el = document.querySelector(sel);
        if (el) { el.focus(); document.execCommand("selectAll"); document.execCommand("delete"); }
      }, COMPOSE_BOX);
      writeAttempt(attemptFile, { kind: "tweet", outcome: "dry_run", cycle });
      return 0;
    }

    await humanDelay(1_500, 3_500);
    console.log(`[${tag}] clicking Post...`);
    await hs.evalFn(tabId, function (sel) {
      const el = document.querySelector(sel);
      if (el) el.click();
      return !!el;
    }, POST_BUTTON);
    await sleep(5_000);
    await reportPendingApprovals(tag);

    const finalUrl = await hs.tabUrl(tabId);
    console.log(`[${tag}] page URL after post: ${finalUrl}`);

    let tweetUrl = isConfirmedStatusUrl(finalUrl) ? finalUrl : null;

    if (!tweetUrl) {
      if (finalUrl.includes("graduated-access")) {
        console.log(`[${tag}] graduated-access interstitial detected — waiting 10s before checking profile...`);
        await sleep(10_000);
        tweetUrl = await confirmFromProfile(tabId, tag, tweetText, 4, 3_000);
        if (!tweetUrl) {
          console.error(`[${tag}] graduated-access blocked the post — X rate-limiting`);
          writeAttempt(attemptFile, {
            kind: "tweet", outcome: "failed", reason: "rate_limited",
            stage: "after_post_click", final_url: finalUrl, cycle,
          });
          return 1;
        }
      } else if (finalUrl.includes("compose")) {
        console.error(`[${tag}] still on compose page — post may have failed`);
        writeAttempt(attemptFile, {
          kind: "tweet", outcome: "failed", reason: "compose_stuck",
          stage: "after_post_click", final_url: finalUrl, cycle,
        });
        return 1;
      } else {
        const postToast = await hs.evalFn(tabId, pageToast).catch(() => null);
        if (postToast) {
          console.error(`[${tag}] anti-automation toast after post: ${postToast}`);
          writeAttempt(attemptFile, {
            kind: "tweet", outcome: "failed", reason: "anti_automation_block",
            stage: "after_post_click", toast: postToast, final_url: finalUrl, cycle,
          });
          return 1;
        }
        console.log(`[${tag}] navigating to profile to confirm post and capture URL...`);
        tweetUrl = await confirmFromProfile(tabId, tag, tweetText, 5, 4_000);
        if (!tweetUrl) {
          if (finalUrl.includes("/home")) {
            console.log(`[${tag}] probable success — clicked Post and stayed on /home, but could not confirm URL`);
            tweetUrl = "posted";
          } else {
            console.error(`[${tag}] could not confirm tweet from profile after 5 attempts`);
            writeAttempt(attemptFile, {
              kind: "tweet", outcome: "failed", reason: "profile_confirm_timeout",
              stage: "profile_confirm", final_url: finalUrl, cycle,
            });
            return 1;
          }
        }
      }
    } else {
      console.log(`[${tag}] SUCCESS: ${tweetUrl}`);
    }

    if (isConfirmedStatusUrl(tweetUrl)) {
      writeResult(resultFile, tweetUrl);
    } else if (tweetUrl === "posted") {
      console.log(`[${tag}] writing soft-confirmed result (no URL captured)`);
      fs.writeFileSync(resultFile, "posted\n");
    } else {
      writeResult(resultFile, tweetUrl);
    }
    writeAttempt(attemptFile, {
      kind: "tweet", outcome: "confirmed", confirmed_url: tweetUrl,
      final_url: finalUrl, backend: "helmstack", cycle,
    });
    logTweet({ content: tweetText, tweet_url: tweetUrl, cycle });

    // Leave the tab on home so the next cycle starts clean
    await hs.navigate(tabId, "https://x.com/home").catch(() => {});
    return 0;

  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    writeAttempt(attemptFile, {
      kind: "tweet", outcome: "failed", reason: "exception", error: err.message, cycle,
    });
    return 1;
  }
}

// ── runQuote ────────────────────────────────────────────────────────────────

async function runQuote({ draftFile, resultFile, attemptFile, cycle }) {
  const tag = "post_quote.hs";
  clearFile(resultFile);

  if (!fs.existsSync(draftFile)) {
    console.error(`[${tag}] no quote_draft.txt found — skipping`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "draft_missing", cycle });
    return 1;
  }

  const raw   = fs.readFileSync(draftFile, "utf-8").trim();
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);

  // Extract source URL: clean line 1, else scan mixed text (same as legacy)
  const URL_RE = /https:\/\/(?:x\.com|twitter\.com)\/[A-Za-z0-9_]+\/status\/\d+/;
  let sourceUrl = "";
  let quoteText = "";
  if (lines.length > 0 && URL_RE.test(lines[0]) && lines[0].match(URL_RE)[0] === lines[0]) {
    sourceUrl = lines[0];
    quoteText = lines.slice(1).join(" ").trim();
  } else {
    const fullText = lines.join(" ");
    const urlMatch = fullText.match(URL_RE);
    if (urlMatch) {
      sourceUrl = urlMatch[0];
      quoteText = fullText.replace(sourceUrl, "").replace(/\s{2,}/g, " ").trim();
      console.log(`[${tag}] extracted URL from mixed text: ${sourceUrl}`);
    }
  }

  if (!sourceUrl) {
    console.error(`[${tag}] no valid x.com/twitter.com status URL found in quote_draft.txt`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "source_url_missing", cycle });
    return 1;
  }
  const sourceHandle = (sourceUrl.match(/x\.com\/([^/]+)/) || [])[1] || "";
  if (sourceHandle.toLowerCase() === "sebhunts_ai") {
    console.error(`[${tag}] cannot quote own tweet — skipping`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "self_quote_blocked", cycle });
    return 1;
  }
  if (!quoteText) {
    console.error(`[${tag}] quote text is empty`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "quote_text_empty", cycle });
    return 1;
  }
  console.log(`[${tag}] quoting: ${sourceUrl}`);
  console.log(`[${tag}] text (${quoteText.length} chars): ${quoteText.slice(0, 80)}...`);
  if (quoteText.length > 280) {
    console.error(`[${tag}] commentary too long (${quoteText.length} > 280 chars)`);
    return 1;
  }
  const vfErrors = voiceFilter.check(quoteText);
  if (vfErrors.length > 0) {
    console.error(`[${tag}] voice_filter rejected draft: ${vfErrors.join("; ")}`);
    writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "voice_filter", cycle });
    return 1;
  }

  const OWN_HANDLES = ["sebhunts_ai", "sebastianhunts", "sebastian_hunts"];

  const tabId = await connectAndGetTab(tag, attemptFile, "quote", cycle);
  if (!tabId) return 1;

  try {
    console.log(`[${tag}] navigating to source tweet: ${sourceUrl}`);
    await hs.navigate(tabId, sourceUrl);
    await hs.waitReady(tabId, { tag });
    await humanDelay(2_000, 4_000);

    await hs.pollFn(tabId, "retweet button",
      () => !!document.querySelector("[data-testid='retweet']"),
      { attempts: 15, interval: 1_000, tag });

    // HARD SKIP: never quote tweets that mention the agent itself
    const mentionsSelf = await hs.evalFn(tabId, function (handles) {
      const tweetEl = document.querySelector('[data-testid="tweetText"]');
      const tweetText = (tweetEl?.innerText || "").toLowerCase();
      const replyEls = document.querySelectorAll('[data-testid="tweet"] a[href^="/"]');
      const replyText = Array.from(replyEls).map(a => (a.getAttribute("href") || "").toLowerCase()).join(" ");
      const full = tweetText + " " + replyText;
      return handles.some(h => full.includes(h) || full.includes("@" + h));
    }, OWN_HANDLES).catch(() => false);
    if (mentionsSelf) {
      console.error(`[${tag}] source tweet mentions the agent — HARD SKIP (never quote mentions of self)`);
      return 1;
    }

    await humanDelay(800, 2_000);
    console.log(`[${tag}] clicking Retweet button...`);
    await hs.evalFn(tabId, () => { document.querySelector("[data-testid='retweet']")?.click(); });

    await hs.pollFn(tabId, "quote menu item", () => {
      const items = Array.from(document.querySelectorAll("[role='menuitem']"));
      return items.some(i => i.innerText?.trim().toLowerCase() === "quote");
    }, { attempts: 8, interval: 1_000, tag });

    await humanDelay(600, 1_500);
    console.log(`[${tag}] clicking Quote option...`);
    const quoted = await hs.evalFn(tabId, function () {
      const items = Array.from(document.querySelectorAll("[role='menuitem']"));
      const q = items.find(i => i.innerText?.trim().toLowerCase() === "quote");
      if (q) { q.click(); return true; }
      return false;
    });
    if (!quoted) throw new Error("Quote menu item click failed");

    await hs.pollFn(tabId, "compose box",
      () => !!document.querySelector('[data-testid="tweetTextarea_0"]'),
      { attempts: 10, interval: 1_000, tag });

    if (!(await insertVerified(tabId, tag, quoteText))) {
      console.error(`[${tag}] text insertion failed after retry — aborting`);
      writeAttempt(attemptFile, { kind: "quote", outcome: "failed", reason: "text_insert_failed", cycle });
      return 1;
    }

    await hs.pollFn(tabId, "post button enabled", () => {
      const el = document.querySelector('[data-testid="tweetButton"],[data-testid="tweetButtonInline"]');
      return el != null && el.getAttribute("aria-disabled") !== "true";
    }, { attempts: 30, interval: 1_000, tag });

    const prePostToast = await hs.evalFn(tabId, pageToast).catch(() => null);
    if (prePostToast) {
      console.error(`[${tag}] anti-automation toast detected before posting: ${prePostToast}`);
      writeAttempt(attemptFile, {
        kind: "quote", outcome: "failed", reason: "anti_automation_block",
        stage: "before_post_click", toast: prePostToast, source_url: sourceUrl, cycle,
      });
      return 1;
    }

    if (DRY_RUN) {
      console.log(`[${tag}] DRY RUN — composer verified, not clicking Post. Closing composer...`);
      await hs.evaluate(tabId, "location.href = 'https://x.com/home'").catch(() => {});
      writeAttempt(attemptFile, { kind: "quote", outcome: "dry_run", source_url: sourceUrl, cycle });
      return 0;
    }

    await humanDelay(1_500, 3_500);
    console.log(`[${tag}] clicking Post...`);
    await hs.evalFn(tabId, function (sel) {
      const el = document.querySelector(sel);
      if (el) el.click();
      return !!el;
    }, POST_BUTTON);
    await sleep(5_000);
    await reportPendingApprovals(tag);

    const finalUrl = await hs.tabUrl(tabId);
    console.log(`[${tag}] page URL after post: ${finalUrl}`);

    let quoteUrl = isConfirmedStatusUrl(finalUrl) && !finalUrl.includes(sourceUrl.split("/status/")[1])
      ? finalUrl : null;

    if (!quoteUrl) {
      console.log(`[${tag}] confirming quote from profile...`);
      quoteUrl = await confirmFromProfile(tabId, tag, quoteText, 5, 4_000);
    }
    if (!quoteUrl) {
      console.error(`[${tag}] could not confirm quote from profile`);
      writeAttempt(attemptFile, {
        kind: "quote", outcome: "failed", reason: "profile_confirm_timeout",
        stage: "profile_confirm", final_url: finalUrl, source_url: sourceUrl, cycle,
      });
      return 1;
    }

    console.log(`[${tag}] SUCCESS: ${quoteUrl}`);
    writeResult(resultFile, quoteUrl);
    writeAttempt(attemptFile, {
      kind: "quote", outcome: "confirmed", confirmed_url: quoteUrl,
      final_url: finalUrl, source_url: sourceUrl, backend: "helmstack", cycle,
    });
    logQuote({ content: quoteText, source_url: sourceUrl, tweet_url: quoteUrl, cycle });

    await hs.navigate(tabId, "https://x.com/home").catch(() => {});
    return 0;

  } catch (err) {
    console.error(`[${tag}] error: ${err.message}`);
    clearFile(resultFile);
    writeAttempt(attemptFile, {
      kind: "quote", outcome: "failed", reason: "exception", error: err.message,
      source_url: sourceUrl, cycle,
    });
    return 1;
  }
}

module.exports = { runTweet, runQuote };
