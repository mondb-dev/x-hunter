#!/usr/bin/env node
/**
 * runner/check_notifs.js — dump recent mentions/notifications.
 *
 * HelmStack path (default; POST_BACKEND=helmstack) uses the X engine's
 * scrapeMentions(). Legacy CDP path retained as a fallback.
 */
"use strict";

async function viaHelmstack() {
  const { HelmStackClient, X } = require("../tools/helmstack-social/src");
  const { HANDLE } = require("./post_result");
  const x = new X(new HelmStackClient(), { ownHandle: HANDLE, log: (m) => console.log(`[check_notifs] ${m}`) });
  await x.c.health();
  await x.ensureTab();
  const mentions = await x.scrapeMentions({ limit: 20 });
  console.log("Mentions found:", mentions.length);
  console.log(JSON.stringify(mentions, null, 2));
  await x.c.navigate(x.tab, "https://x.com/home").catch(() => {});
}

async function viaCDP() {
  const { connectBrowser, getXPage } = require("./cdp");
  const browser = await connectBrowser();
  const page = await getXPage(browser);
  await page.goto("https://x.com/notifications", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await new Promise(r => setTimeout(r, 2_500));
  for (const t of await page.$$('[role="tab"]')) {
    const label = await t.evaluate(el => el.innerText).catch(() => "");
    if (/mentions/i.test(label)) { await t.click(); await new Promise(r => setTimeout(r, 1_500)); break; }
  }
  await new Promise(r => setTimeout(r, 1_000));
  const articles = await page.$$eval('article[data-testid="tweet"]', els => els.map(a => {
    const textEl = a.querySelector('[data-testid="tweetText"]');
    const userEl = a.querySelector('[data-testid="User-Name"]');
    const link = a.querySelector('a[href*="/status/"]');
    const id = link && link.href.match(/\/status\/(\d+)/) ? link.href.match(/\/status\/(\d+)/)[1] : "";
    return { id, user: userEl ? userEl.innerText.split("\n")[0] : "", text: textEl ? textEl.innerText.slice(0, 120) : "" };
  }));
  console.log("Articles found:", articles.length);
  console.log(JSON.stringify(articles, null, 2));
  browser.disconnect();
}

(async () => {
  if ((process.env.POST_BACKEND || "").toLowerCase() === "helmstack") return viaHelmstack();
  return viaCDP();
})().catch(e => console.error("[check_notifs]", e.message));
