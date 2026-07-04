#!/usr/bin/env node
/**
 * runner/helmstack_bootstrap.js — one-off X session transplant into HelmStack
 *
 * Copies the logged-in x.com session from the legacy x-hunter Chrome profile
 * (via CDP on port 18801) into HelmStack's browser (via its HTTP API), then
 * verifies the session by loading x.com/home and checking for the compose UI.
 *
 * Usage: HELMSTACK_AUTH_TOKEN=... node helmstack_bootstrap.js
 * Exit 0 = HelmStack is logged into X, exit 1 = transplant failed
 */

"use strict";

const { connectBrowser, getXPage } = require("./cdp");
const hs = require("./lib/helmstack");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ── 1. Export cookies from the legacy Chrome profile ───────────────────────
  console.log("[bootstrap] connecting to legacy Chrome (CDP :18801)...");
  const browser = await connectBrowser();
  const page = await getXPage(browser);
  const cookies = await page.cookies("https://x.com", "https://twitter.com");
  browser.disconnect();
  console.log(`[bootstrap] exported ${cookies.length} cookies from x-hunter profile`);
  if (!cookies.some(c => c.name === "auth_token")) {
    console.error("[bootstrap] no auth_token cookie in legacy profile — is Chrome logged into X?");
    process.exit(1);
  }

  // ── 2. Import into HelmStack ────────────────────────────────────────────────
  const health = await hs.health();
  console.log(`[bootstrap] HelmStack up (${JSON.stringify(health).slice(0, 80)})`);
  const tabId = await hs.ensureXTab();
  console.log(`[bootstrap] using HelmStack tab ${tabId}`);

  let ok = 0, failed = 0;
  for (const c of cookies) {
    try {
      await hs.setCookie(tabId, {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      });
      ok++;
    } catch (err) {
      failed++;
      console.error(`[bootstrap] cookie ${c.name} failed: ${err.message}`);
    }
  }
  console.log(`[bootstrap] imported ${ok}/${cookies.length} cookies (${failed} failed)`);

  // ── 3. Verify the session ───────────────────────────────────────────────────
  console.log("[bootstrap] loading x.com/home to verify session...");
  await hs.navigate(tabId, "https://x.com/home");
  await hs.waitReady(tabId, { tag: "bootstrap" });
  await sleep(5_000);

  const check = await hs.evalFn(tabId, function () {
    const compose = !!document.querySelector('[data-testid="tweetTextarea_0"], [data-testid="SideNav_NewTweet_Button"]');
    const loginWall = !!document.querySelector('[data-testid="loginButton"], a[href="/login"]');
    const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const handle = profileLink ? (profileLink.getAttribute("href") || "").replace("/", "") : null;
    return { compose, loginWall, handle };
  });

  console.log(`[bootstrap] session check: ${JSON.stringify(check)}`);
  if (check && check.compose && !check.loginWall) {
    console.log(`[bootstrap] SUCCESS — HelmStack is logged into X${check.handle ? ` as @${check.handle}` : ""}`);
    process.exit(0);
  }
  console.error("[bootstrap] FAILED — x.com does not show a logged-in UI in HelmStack");
  process.exit(1);
})().catch(err => {
  console.error(`[bootstrap] error: ${err.message}`);
  process.exit(1);
});
