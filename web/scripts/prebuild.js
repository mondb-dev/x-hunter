#!/usr/bin/env node
// web/scripts/prebuild.js — copy data files from repo root into web/data/ for Vercel

const fs   = require("fs");
const path = require("path");

const cwd = process.cwd();
console.log("[prebuild] cwd:", cwd);

// Content directories — copied wholesale
const contentDirs = ["journals", "checkpoints", "articles", "ponders", "landmarks"];

for (const d of contentDirs) {
  const src = path.resolve(cwd, "..", d);
  const dst = path.resolve(cwd, "data", d);
  if (!fs.existsSync(src)) {
    console.log(`[prebuild] ${d}: not found, skipping`);
    continue;
  }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
  console.log(`[prebuild] ${d}: copied → ${dst} (${fs.readdirSync(dst).length} items)`);
}

// State — only the specific files the web app reads
const STATE_FILES = [
  "ontology.json",
  "arweave_log.json",
  "intelligence_export.json",
  "belief_state.json",
  "posts_log.json",
  "prediction_export.json",
  "sprint_snapshot.json",
  "active_plan.json",
  "action_plans.json",
  "verification_export.json",
];

const stateSrc = path.resolve(cwd, "..", "state");
const stateDst = path.resolve(cwd, "data", "state");
fs.rmSync(stateDst, { recursive: true, force: true });
fs.mkdirSync(stateDst, { recursive: true });
let stateCount = 0;
for (const f of STATE_FILES) {
  const src = path.join(stateSrc, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(stateDst, f));
    stateCount++;
  }
}
console.log(`[prebuild] state: copied ${stateCount}/${STATE_FILES.length} files → ${stateDst}`);

// daily/ belief reports
const dailySrc = path.resolve(cwd, "..", "daily");
const dailyDst = path.resolve(cwd, "data", "daily");
if (fs.existsSync(dailySrc)) {
  fs.rmSync(dailyDst, { recursive: true, force: true });
  fs.mkdirSync(dailyDst, { recursive: true });
  fs.cpSync(dailySrc, dailyDst, { recursive: true, force: true });
  console.log(`[prebuild] daily: copied → ${dailyDst} (${fs.readdirSync(dailyDst).length} items)`);
}

// manifesto
const manifesto = path.resolve(cwd, "..", "manifesto.md");
if (fs.existsSync(manifesto)) {
  fs.copyFileSync(manifesto, path.resolve(cwd, "data", "manifesto.md"));
  console.log("[prebuild] manifesto.md copied");
}


// Article image manifest — small JSON listing which slugs have images.
// Small JSON listing which slugs have cover images.
// Images served directly from GitHub raw content.
const imagesDir = path.resolve(cwd, 'data', 'articles', 'images');
if (fs.existsSync(imagesDir)) {
  const imageSlugs = fs.readdirSync(imagesDir)
    .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => f.replace(/\.[^.]+$/, ''));
  fs.writeFileSync(
    path.resolve(cwd, 'data', 'article_images.json'),
    JSON.stringify(imageSlugs)
  );
  console.log('[prebuild] article_images.json: ' + imageSlugs.length + ' entries');
  // Remove images from data/ — not needed at runtime, images served from GitHub raw.
  fs.rmSync(imagesDir, { recursive: true, force: true });
}
console.log("[prebuild] done");
