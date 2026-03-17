#!/usr/bin/env node
/**
 * runner/update_bio.js — update Sebastian's X bio based on vocation status.
 *
 * Reads state/vocation.json and state/profile.json.
 * Uses LLM to generate a bio that reflects current vocation state (per AGENTS.md §15.2).
 * Navigates to x.com/settings/profile via CDP and updates the bio field.
 * Writes changes back to state/profile.json.
 *
 * Called from run.sh after evaluate_vocation.js when vocation status changes.
 * Self-gates: only runs if vocation status has changed since last bio update,
 * or if bio has never been set.
 *
 * Usage: node runner/update_bio.js
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const { connectBrowser } = require("./cdp");
const { callVertex }     = require("./vertex.js");

const ROOT     = path.resolve(__dirname, "..");
const VOCATION = path.join(ROOT, "state", "vocation.json");
const PROFILE  = path.join(ROOT, "state", "profile.json");

// Load .env
if (fs.existsSync(path.join(ROOT, ".env"))) {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function loadJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Generate a bio based on vocation status (per AGENTS.md §15.2).
 * - Pre-vocation:  "Watching. Reading. Forming a view. Ask me again in a week."
 * - Forming:       Reflect the emerging domain in one sentence.
 * - Defined:       Name the domain directly and hint at position.
 */
async function generateBio(vocation) {
  const status = vocation?.status || "not_triggered";

  if (status === "not_triggered") {
    return "Watching. Reading. Forming a view. Ask me again in a week.";
  }

  const label = vocation.label || "";
  const description = vocation.description || "";
  const intent = vocation.intent || "";

  const prompt = [
    "You are writing a Twitter/X bio for Sebastian D. Hunter, an AI that reads X discourse",
    "and forms beliefs from scratch. The bio must be in first person, under 160 characters,",
    "no buzzwords, no labels, no tribe signaling. Honest about uncertainty.",
    "",
    status === "forming"
      ? "His vocation is FORMING — he has a direction but it's not yet stable."
      : "His vocation is DEFINED — he has a clear, stable direction.",
    "",
    `Vocation label: ${label}`,
    `Description: ${description}`,
    `Intent: ${intent}`,
    "",
    status === "forming"
      ? "Write ONE sentence saying what he's trying to understand. First person. Under 160 chars."
      : "Name his domain directly and hint at his angle/position. First person. Under 160 chars.",
    "",
    "Return ONLY the bio text, nothing else. No quotes around it.",
  ].join("\n");

  try {
    const result = await callVertex(prompt, 128);
    const bio = result.trim().replace(/^["']|["']$/g, "");
    if (bio.length > 160) return bio.slice(0, 157) + "...";
    return bio;
  } catch (err) {
    console.error(`[update_bio] LLM failed: ${err.message}`);
    // Sensible fallback
    if (status === "forming") {
      return label
        ? `Trying to understand ${label.toLowerCase()}. Work in progress.`
        : "Forming a worldview from first principles. Work in progress.";
    }
    return label
      ? `Focused on ${label.toLowerCase()}. Beliefs formed from reading, not ideology.`
      : "Beliefs formed from reading, not ideology.";
  }
}

/**
 * Navigate to x.com/settings/profile and update the bio field.
 */
async function updateBioOnX(newBio) {
  const browser = await connectBrowser();
  let page;
  try {
    page = await browser.newPage();
  } catch {
    // Try using existing page
    const pages = await browser.pages();
    page = pages[0];
  }

  console.log("[update_bio] navigating to profile settings...");
  await page.goto("https://x.com/settings/profile", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await sleep(3_000);

  // Find the bio textarea — X uses a textarea with name="description" or data-testid
  const bioSelector = 'textarea[name="description"], [data-testid="ocfEnterTextTextInput"]';
  try {
    await page.waitForSelector(bioSelector, { timeout: 10_000 });
  } catch {
    // Try alternate: look for the label "Bio" and find nearby textarea
    console.log("[update_bio] primary selector not found, trying alternate...");
    const found = await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("span"));
      for (const l of labels) {
        if (l.textContent === "Bio") {
          const textarea = l.closest("[data-testid]")?.querySelector("textarea");
          if (textarea) { textarea.focus(); return true; }
        }
      }
      // Also try any textarea on the page
      const tas = Array.from(document.querySelectorAll("textarea"));
      if (tas.length > 0) { tas[0].focus(); return true; }
      return false;
    });
    if (!found) {
      throw new Error("Could not find bio textarea on settings page");
    }
  }

  // Clear existing bio and type new one
  await page.evaluate((sel) => {
    const textarea = document.querySelector(sel) || document.activeElement;
    if (textarea && textarea.tagName === "TEXTAREA") {
      textarea.focus();
      textarea.select();
    }
  }, bioSelector);
  await sleep(300);

  // Select all and delete
  await page.keyboard.down("Meta");
  await page.keyboard.press("a");
  await page.keyboard.up("Meta");
  await sleep(200);
  await page.keyboard.press("Backspace");
  await sleep(300);

  // Type new bio
  await page.keyboard.type(newBio, { delay: 30 });
  await sleep(1_000);

  // Click Save button
  const saveClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("[data-testid='Profile_Save_Button'], button"));
    for (const btn of btns) {
      if (btn.textContent?.trim() === "Save" || btn.getAttribute("data-testid") === "Profile_Save_Button") {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!saveClicked) {
    console.error("[update_bio] could not find Save button — bio was typed but not saved");
  } else {
    await sleep(3_000);
    console.log("[update_bio] Save clicked, waiting for confirmation...");
  }

  browser.disconnect();
  return saveClicked;
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  try {
    const vocation = loadJson(VOCATION, { status: "not_triggered" });
    const profile  = loadJson(PROFILE, {
      display_name: null, bio: "", bio_history: [],
      pfp_set: false, header_set: false,
      pinned_tweet_url: null, website_url: null,
      profile_last_updated: null,
      community: { created: false, url: null, name: null, created_at: null },
    });

    const currentStatus = vocation.status || "not_triggered";
    const lastBioStatus = profile._last_vocation_status || null;
    const hasBio        = profile.bio && profile.bio.length > 0;

    // Self-gate: only run if vocation status changed or bio never set
    if (hasBio && lastBioStatus === currentStatus) {
      console.log(`[update_bio] no change needed (status still "${currentStatus}"). skipping.`);
      process.exit(0);
    }

    console.log(`[update_bio] vocation status: "${currentStatus}" (was: "${lastBioStatus || "none"}")`);

    // Generate new bio
    const newBio = await generateBio(vocation);
    console.log(`[update_bio] generated bio (${newBio.length} chars): ${newBio}`);

    // Update on X
    const saved = await updateBioOnX(newBio);

    // Update profile.json
    if (saved) {
      if (profile.bio) {
        if (!profile.bio_history) profile.bio_history = [];
        profile.bio_history.push({
          bio: profile.bio,
          replaced_at: new Date().toISOString(),
          vocation_status: lastBioStatus || "unknown",
        });
      }
      profile.bio = newBio;
      profile._last_vocation_status = currentStatus;
      profile.profile_last_updated = new Date().toISOString();
      saveJson(PROFILE, profile);
      console.log(`[update_bio] profile.json updated.`);
    }

    process.exit(0);
  } catch (err) {
    console.error(`[update_bio] error: ${err.message}`);
    process.exit(0); // non-fatal
  }
})();
