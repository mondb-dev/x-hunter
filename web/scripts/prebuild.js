#!/usr/bin/env node
// web/scripts/prebuild.js — copy data files from repo root into web/data/ for Vercel

const fs   = require("fs");
const path = require("path");

const cwd = process.cwd();
console.log("[prebuild] cwd:", cwd);

const dirs = ["state", "daily", "journals", "checkpoints", "articles", "ponders", "landmarks"];

for (const d of dirs) {
  const src = path.resolve(cwd, "..", d);
  const dst = path.resolve(cwd, "data", d);
  const exists = fs.existsSync(src);
  console.log(`[prebuild] ${d}: src=${src} exists=${exists}`);
  if (exists) {
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: true });
    const count = fs.readdirSync(dst).length;
    console.log(`[prebuild] ${d}: copied → ${dst} (${count} items)`);
  }
}

const manifesto = path.resolve(cwd, "..", "manifesto.md");
if (fs.existsSync(manifesto)) {
  fs.copyFileSync(manifesto, path.resolve(cwd, "data", "manifesto.md"));
  console.log("[prebuild] manifesto.md copied");
}

// Copy article cover images → public/images/articles/ for static serving
const articleImages = path.resolve(cwd, "..", "articles", "images");
if (fs.existsSync(articleImages)) {
  const dst = path.resolve(cwd, "public", "images", "articles");
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(articleImages, dst, { recursive: true, force: true });
  const count = fs.readdirSync(dst).length;
  console.log(`[prebuild] article images: copied → ${dst} (${count} items)`);
}

console.log("[prebuild] done");
