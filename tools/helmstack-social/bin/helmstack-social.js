#!/usr/bin/env node
"use strict";
/**
 * helmstack-social CLI
 *
 *   helmstack-social health
 *   helmstack-social linkedin post   --text "..."   | --file draft.txt   [--dry-run]
 *   helmstack-social linkedin engage [--keywords kw.txt] [--max-likes N] [--max-comments N]
 *                                    [--comment-command "cmd"] [--seen ledger.json] [--dry-run]
 *   helmstack-social bootstrap       --cookies cookies.json
 *
 * Config comes from env: HELMSTACK_URL, HELMSTACK_AUTH_TOKEN.
 * `--comment-command` receives the post JSON on stdin and must print the comment
 * text on stdout (empty/"SKIP" = no comment) — this is how you plug in an LLM.
 */

const fs = require("fs");
const { execFileSync } = require("child_process");
const { HelmStackClient, LinkedIn, X, session } = require("../src");

function arg(flags, def) {
  const argv = process.argv;
  for (const f of [].concat(flags)) {
    const i = argv.indexOf(f);
    if (i >= 0) return argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[i + 1];
  }
  return def;
}
const has = (f) => process.argv.includes(f);

function keywordScorer(keywordsFile) {
  const words = new Set();
  if (keywordsFile && fs.existsSync(keywordsFile)) {
    fs.readFileSync(keywordsFile, "utf-8").toLowerCase().split(/[^a-z0-9-]+/).forEach((w) => {
      if (w.length >= 4) words.add(w);
    });
  }
  return (post) => {
    if (!words.size) return 1; // no keywords → treat all as minimally relevant
    const toks = new Set(String(post.text || "").toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 4));
    let hits = 0;
    for (const t of toks) if (words.has(t)) hits++;
    return hits;
  };
}

async function main() {
  const client = new HelmStackClient();
  const [, , cmd, sub] = process.argv;

  if (cmd === "health") {
    console.log(JSON.stringify(await client.health()));
    return;
  }

  if (cmd === "bootstrap") {
    const file = arg("--cookies");
    if (!file || file === true) throw new Error("bootstrap requires --cookies <file.json>");
    const cookies = JSON.parse(fs.readFileSync(file, "utf-8"));
    const li = new LinkedIn(client);
    await li.ensureTab();
    const r = await session.importCookies(client, li.tab, cookies);
    console.log(`imported ${r.imported}/${r.total} cookies (${r.failed} failed)`);
    const ok = await li.sessionOk();
    console.log(ok ? "session OK (li_at present)" : "session NOT present");
    process.exit(ok ? 0 : 1);
  }

  if (cmd === "linkedin") {
    const li = new LinkedIn(client, { ownHandleHint: arg("--own-handle", "") });
    await li.ensureTab();
    if (!(await li.sessionOk())) throw new Error("LinkedIn session not present (no li_at cookie)");
    const dryRun = has("--dry-run");

    if (sub === "post") {
      let text = arg("--text");
      const file = arg("--file");
      if (file && file !== true) text = fs.readFileSync(file, "utf-8").trim();
      if (!text || text === true) throw new Error("linkedin post requires --text or --file");
      const res = await li.post(text, { dryRun });
      console.log(JSON.stringify(res));
      process.exit(res.posted || res.dryRun ? 0 : 1);
    }

    if (sub === "engage") {
      const score = keywordScorer(arg("--keywords"));
      const commentCmd = arg("--comment-command");
      const seenFile = arg("--seen");
      const seen = new Set(seenFile && seenFile !== true && fs.existsSync(seenFile)
        ? JSON.parse(fs.readFileSync(seenFile, "utf-8")) : []);
      const generateComment = commentCmd && commentCmd !== true
        ? async (post) => {
            try {
              const out = execFileSync("/bin/sh", ["-c", commentCmd], { input: JSON.stringify(post), encoding: "utf-8" }).trim();
              return out && out !== "SKIP" ? out : null;
            } catch { return null; }
          }
        : null;
      const r = await li.engage({
        score, generateComment, seen,
        maxLikes: Number(arg("--max-likes", 3)),
        maxComments: Number(arg("--max-comments", 1)),
        minScore: Number(arg("--min-score", 1)),
        dryRun,
      });
      if (seenFile && seenFile !== true) fs.writeFileSync(seenFile, JSON.stringify([...seen].slice(-500), null, 2));
      console.log(JSON.stringify(r));
      return;
    }

    throw new Error(`unknown linkedin subcommand: ${sub}`);
  }

  if (cmd === "x") {
    const x = new X(client, { ownHandle: arg("--own-handle", "SebastianHunts") });
    await x.ensureTab();
    if (!(await x.sessionOk())) throw new Error("X session not present (no auth_token/ct0 cookie)");
    const dryRun = has("--dry-run");

    if (sub === "post") {
      let text = arg("--text");
      const file = arg("--file");
      if (file && file !== true) text = fs.readFileSync(file, "utf-8").trim();
      if (!text || text === true) throw new Error("x post requires --text or --file");
      const res = await x.post(text, { dryRun });
      console.log(JSON.stringify(res));
      process.exit(res.posted || res.dryRun ? 0 : 1);
    }

    if (sub === "engage") {
      const score = keywordScorer(arg("--keywords"));
      const replyCmd = arg("--reply-command");
      const seenFile = arg("--seen");
      const seen = new Set(seenFile && seenFile !== true && fs.existsSync(seenFile)
        ? JSON.parse(fs.readFileSync(seenFile, "utf-8")) : []);
      const generateReply = replyCmd && replyCmd !== true
        ? async (post) => {
            try {
              const out = execFileSync("/bin/sh", ["-c", replyCmd], { input: JSON.stringify(post), encoding: "utf-8" }).trim();
              return out && out !== "SKIP" ? out : null;
            } catch { return null; }
          }
        : null;
      const r = await x.engage({
        score, generateReply, seen,
        maxLikes: Number(arg("--max-likes", 3)),
        maxReplies: Number(arg("--max-replies", 1)),
        minScore: Number(arg("--min-score", 1)),
        dryRun,
      });
      if (seenFile && seenFile !== true) fs.writeFileSync(seenFile, JSON.stringify([...seen].slice(-500), null, 2));
      console.log(JSON.stringify(r));
      return;
    }

    throw new Error(`unknown x subcommand: ${sub}`);
  }

  console.error("usage: helmstack-social <health|bootstrap|linkedin post|linkedin engage|x post|x engage> [options]");
  process.exit(2);
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});
