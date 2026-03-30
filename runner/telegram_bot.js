'use strict';

/**
 * runner/telegram_bot.js — Interactive Telegram bot for Sebastian Hunter
 *
 * Long-polls the Telegram Bot API for incoming messages and responds to
 * commands. Runs as a separate systemd service alongside the orchestrator.
 *
 * Commands:
 *   /status              → orchestrator overview (cycle, day, paused, posting stats)
 *   /services            → service + process status for runner/gateway/bot/browser/scraper
 *   /health              → browser + agent health state
 *   /last                → last cycle's full structured log (JSON)
 *   /logs N              → last N cycles summary (default 5)
 *   /ontology            → belief axes overview (top 10 by confidence)
 *   /posts               → recent X posts
 *   /journal             → latest journal entry summary
 *   /vocation            → current vocation status and direction
 *   /builder             → current builder proposal status
 *   /builder ask <text>  → ask builder about the active proposal/work
 *   /vm                  → VM resource usage (CPU, memory, disk, uptime)
 *   /errors              → recent errors from journalctl
 *   /drift               → recent drift alerts
 *   /restart [target]    → restart browser|runner|gateway|scraper|all
 *   /troubleshoot        → diagnose system health
 *   /troubleshoot fix    → diagnose and apply safe fixes when possible
 *   /pause               → pause the orchestrator
 *   /resume              → resume the orchestrator
 *   /help                → list all commands
 *
 * Any other text → forwarded to openclaw agent as a chat message
 * (only when orchestrator is not running a cycle).
 *
 * Usage:
 *   systemctl start sebastian-tgbot
 *   (or: cd ~/hunter && source .env && node runner/telegram_bot.js)
 *
 * Requires: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync, spawnSync } = require('child_process');
const config = require('./lib/config');

// Default every spawned OpenClaw command to the dedicated x-hunter profile.
process.env.OPENCLAW_PROFILE = process.env.OPENCLAW_PROFILE || 'x-hunter';
process.env.OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR
  || path.join(process.env.HOME || '', `.openclaw-${process.env.OPENCLAW_PROFILE}`);
process.env.OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
  || path.join(process.env.OPENCLAW_STATE_DIR, 'openclaw.json');

// ── Config ──────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const POLL_INTERVAL = 3000;        // ms between polls when idle
const AGENT_TIMEOUT_MS = 300_000;  // 5 min max for interactive agent calls
const CYCLE_LOCK_PATH = path.join(config.STATE_DIR, 'cycle.lock');
const STARTED_AT = new Date();
const BUILDER_TIMEOUT_MS = 180_000;
const SYSTEMCTL_BIN = shellPath('systemctl') || '/usr/bin/systemctl';

let lastUpdateId = 0;

// ── Telegram helpers ────────────────────────────────────────────────────────

function telegramAPI(method, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 35000,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

async function sendMessage(text, parseMode = 'HTML') {
  try {
    // Telegram max message length is 4096 chars
    if (text.length > 4000) text = text.slice(0, 4000) + '\n\n<i>[truncated]</i>';
    await telegramAPI('sendMessage', {
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.log(`[tgbot] send error: ${e.message}`);
  }
}

async function sendTyping() {
  try {
    await telegramAPI('sendChatAction', { chat_id: CHAT_ID, action: 'typing' });
  } catch {}
}

// ── Lockfile ────────────────────────────────────────────────────────────────

function isCycleLocked() {
  try {
    if (!fs.existsSync(CYCLE_LOCK_PATH)) return false;
    const stat = fs.statSync(CYCLE_LOCK_PATH);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > 20 * 60 * 1000) {
      console.log('[tgbot] stale cycle lock detected — ignoring');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── File readers ────────────────────────────────────────────────────────────

function readJSON(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf-8')); } catch { return null; }
}

function readText(filepath) {
  try { return fs.readFileSync(filepath, 'utf-8').trim(); } catch { return ''; }
}

function readLastLines(filepath, n = 5) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8').trim();
    const lines = content.split('\n');
    return lines.slice(-n);
  } catch { return []; }
}

function shell(cmd, timeout = 10_000) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout, stdio: 'pipe' }).trim();
  } catch { return ''; }
}

function shellPath(binary) {
  return shell(`command -v ${binary} 2>/dev/null`) || '';
}

function execCapture(file, args, timeout = 15_000) {
  try {
    const stdout = execFileSync(file, args, {
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString().trim() : '',
      stderr: e.stderr ? e.stderr.toString().trim() : (e.message || ''),
      code: e.status ?? 1,
    };
  }
}

function systemdState(service) {
  return shell(`${SYSTEMCTL_BIN} is-active ${service} 2>/dev/null`) || 'unknown';
}

function sudoSystemctl(action, service, timeout = 30_000) {
  return execCapture('sudo', ['-n', SYSTEMCTL_BIN, action, service], timeout);
}

function browserResponsive() {
  try {
    execSync(`curl -sf http://127.0.0.1:${config.CDP_PORT}/json/version`, {
      stdio: 'pipe',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function scraperLoopState() {
  const pidFiles = [
    ['collect', path.join(config.SCRAPER_DIR, 'scraper.pid')],
    ['reply', path.join(config.SCRAPER_DIR, 'reply.pid')],
    ['follows', path.join(config.SCRAPER_DIR, 'follows.pid')],
  ];
  const state = [];

  for (const [label, pidFile] of pidFiles) {
    const pid = readText(pidFile);
    if (!pid) {
      state.push({ label, running: false, pid: null });
      continue;
    }
    const alive = execCapture('kill', ['-0', pid], 5000).ok;
    state.push({ label, running: alive, pid });
  }

  return state;
}

function restartBrowserProfile() {
  try {
    execSync('openclaw browser --browser-profile x-hunter stop', {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {}

  execCapture('sleep', ['3'], 4000);

  try {
    execSync('openclaw browser --browser-profile x-hunter start', {
      stdio: 'ignore',
      timeout: 15_000,
    });
  } catch {}

  execCapture('sleep', ['5'], 6000);
  return browserResponsive();
}

function restartScraperLoops() {
  const stop = execCapture('/bin/bash', [path.join(config.SCRAPER_DIR, 'stop.sh')], 20_000);
  const start = execCapture('/bin/bash', [path.join(config.SCRAPER_DIR, 'start.sh')], 20_000);
  return {
    ok: start.ok,
    stop,
    start,
    loops: scraperLoopState(),
  };
}

function getBuilderSnapshot() {
  const proposal = readJSON(config.PROCESS_PROPOSAL_PATH);
  const history = readJSON(config.PROPOSAL_HISTORY_PATH) || { proposals: [] };
  const proposals = Array.isArray(history.proposals) ? history.proposals : [];

  if (proposal) {
    const matchingHistory = proposals
      .filter((entry) => entry.id === proposal.id)
      .sort((a, b) => String(b.resolved_at || '').localeCompare(String(a.resolved_at || '')));
    return {
      active: true,
      proposal,
      lastHistory: matchingHistory[0] || null,
    };
  }

  const lastHistory = proposals
    .slice()
    .sort((a, b) => String(b.resolved_at || b.proposed_at || '').localeCompare(String(a.resolved_at || a.proposed_at || '')))[0] || null;

  return {
    active: false,
    proposal: null,
    lastHistory,
  };
}

function buildBuilderStatusMessage() {
  const snapshot = getBuilderSnapshot();

  if (!snapshot.active && !snapshot.lastHistory) {
    return '<b>🛠 Builder</b>\n\n<i>No active or historical proposal found</i>';
  }

  if (!snapshot.active && snapshot.lastHistory) {
    let msg = '<b>🛠 Builder</b>\n\n';
    msg += 'State: idle\n';
    msg += `Last proposal: <b>${escapeHtml(snapshot.lastHistory.title || snapshot.lastHistory.id || 'unknown')}</b>\n`;
    msg += `Status: ${escapeHtml(snapshot.lastHistory.status || 'unknown')}\n`;
    if (snapshot.lastHistory.resolution_notes) {
      msg += `Resolution: ${escapeHtml(String(snapshot.lastHistory.resolution_notes).slice(0, 240))}\n`;
    }
    return msg;
  }

  const proposal = snapshot.proposal;
  let msg = '<b>🛠 Builder</b>\n\n';
  msg += `Status: <b>${escapeHtml(proposal.status || 'unknown')}</b>\n`;
  msg += `Title: ${escapeHtml(proposal.title || proposal.id || 'untitled')}\n`;
  msg += `Scope: ${escapeHtml(proposal.scope || 'unknown')}\n`;
  msg += `Risk: ${escapeHtml(proposal.estimated_risk || 'unknown')}\n`;
  if (proposal.created_at) msg += `Created: ${escapeHtml(proposal.created_at)}\n`;
  if (Array.isArray(proposal.affected_files) && proposal.affected_files.length) {
    msg += `Files: ${escapeHtml(proposal.affected_files.join(', '))}\n`;
  }
  if (proposal.proposed_solution) {
    msg += `\n${escapeHtml(String(proposal.proposed_solution).slice(0, 500))}`;
  }
  if (snapshot.lastHistory?.resolution_notes) {
    msg += `\n\nLast attempt: ${escapeHtml(String(snapshot.lastHistory.resolution_notes).slice(0, 220))}`;
  }
  return msg;
}

function runBuilderQuestion(question) {
  const snapshot = getBuilderSnapshot();
  const proposal = snapshot.proposal;

  if (!proposal) {
    return {
      ok: false,
      error: 'Builder is idle right now. There is no active proposal to ask about.',
    };
  }

  const prompt = [
    'You are the Sebastian Hunter builder assistant.',
    'You do not have shell access, browser access, or deployment authority.',
    'Answer only from the active proposal and proposal history provided below.',
    'Keep the answer concise and practical. Max 700 characters.',
    '',
    '## Active proposal',
    JSON.stringify(proposal, null, 2),
    '',
    '## Last historical record',
    JSON.stringify(snapshot.lastHistory || {}, null, 2),
    '',
    `Operator question: ${question}`,
  ].join('\n');

  const tmpPrompt = path.join(config.STATE_DIR, `builder_tg_prompt_${Date.now()}.txt`);
  fs.writeFileSync(tmpPrompt, prompt, 'utf-8');

  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'builder_call.js'), tmpPrompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: BUILDER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });

    if (result.signal === 'SIGKILL') {
      return { ok: false, error: 'Builder timed out.' };
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      return { ok: false, error: stderr || 'Builder call failed.' };
    }

    const stdout = (result.stdout || '').toString().trim();
    return { ok: true, text: stdout || 'Builder returned no output.' };
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
  }
}

function collectTroubleshootingFindings() {
  const runnerState = systemdState('sebastian-runner.service');
  const gatewayState = systemdState('openclaw-gateway.service');
  const botState = systemdState('sebastian-tgbot.service');
  const browserOk = browserResponsive();
  const loops = scraperLoopState();
  const heartbeat = readText(config.HEARTBEAT_PATH);
  const recentRunnerErrors = shell(
    'grep -i "error\\|fail\\|crash\\|timeout\\|fatal" ' +
    `"${config.RUNNER_LOG_PATH}" 2>/dev/null | tail -5`,
    10_000,
  );

  const findings = [];

  if (runnerState !== 'active') {
    findings.push({
      severity: 'error',
      key: 'runner',
      message: `sebastian-runner.service is ${runnerState}`,
      fix: 'runner',
    });
  }

  if (gatewayState !== 'active') {
    findings.push({
      severity: 'error',
      key: 'gateway',
      message: `openclaw-gateway.service is ${gatewayState}`,
      fix: 'gateway',
    });
  }

  if (!browserOk) {
    findings.push({
      severity: 'error',
      key: 'browser',
      message: 'Browser CDP is not responding on the local port',
      fix: 'browser',
    });
  }

  const missingLoops = loops.filter((loop) => !loop.running);
  if (missingLoops.length > 0) {
    findings.push({
      severity: runnerState === 'active' ? 'warn' : 'info',
      key: 'scraper',
      message: `Scraper loops down: ${missingLoops.map((loop) => loop.label).join(', ')}`,
      fix: 'scraper',
    });
  }

  if (!heartbeat) {
    findings.push({
      severity: 'warn',
      key: 'heartbeat',
      message: 'HEARTBEAT.md is empty or unreadable',
      fix: null,
    });
  }

  if (recentRunnerErrors) {
    findings.push({
      severity: 'info',
      key: 'recent_errors',
      message: `Recent runner errors detected:\n${recentRunnerErrors}`,
      fix: null,
    });
  }

  return {
    runnerState,
    gatewayState,
    botState,
    browserOk,
    loops,
    heartbeat,
    findings,
  };
}

function formatTroubleshootingReport(report, fixes = []) {
  let msg = '<b>🧰 Troubleshoot</b>\n\n';
  msg += `Runner: ${escapeHtml(report.runnerState)}\n`;
  msg += `Gateway: ${escapeHtml(report.gatewayState)}\n`;
  msg += `TG bot: ${escapeHtml(report.botState)}\n`;
  msg += `Browser: ${report.browserOk ? 'responsive' : 'down'}\n`;
  msg += `Scraper: ${report.loops.map((loop) => `${loop.label}=${loop.running ? 'up' : 'down'}`).join(', ')}\n`;

  if (report.findings.length === 0) {
    msg += '\n✅ No obvious issues detected';
  } else {
    msg += '\n<b>Findings:</b>\n';
    for (const finding of report.findings) {
      msg += `- [${finding.severity}] ${escapeHtml(finding.message)}\n`;
    }
  }

  if (fixes.length > 0) {
    msg += '\n<b>Fixes applied:</b>\n';
    for (const fix of fixes) {
      msg += `- ${escapeHtml(fix)}\n`;
    }
  }

  return msg;
}

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  return parts.join(' ') || '<1m';
}

// ── Command handlers ────────────────────────────────────────────────────────

async function cmdStatus() {
  const lines = readLastLines(config.ORCHESTRATOR_LOG_PATH, 1);
  const last = lines[0] ? (() => { try { return JSON.parse(lines[0]); } catch { return null; } })() : null;
  const paused = fs.existsSync(config.PAUSE_FILE);
  const locked = isCycleLocked();
  const heartbeat = readText(config.HEARTBEAT_PATH);

  // Check browser health
  const browserOk = browserResponsive();

  // Check orchestrator service
  const orchStatus = systemdState('sebastian-runner.service');
  const builder = getBuilderSnapshot();

  let msg = '<b>📊 Status</b>\n\n';
  msg += `Service: ${orchStatus === 'active' ? '🟢 running' : '🔴 ' + (orchStatus || 'unknown')}\n`;
  msg += `Browser: ${browserOk ? '🟢 CDP responsive' : '🔴 CDP down'}\n`;
  msg += `Paused: ${paused ? '⏸ YES' : '▶️ No'}\n`;
  msg += `Cycle lock: ${locked ? '🔄 active' : '💤 idle'}\n`;
  msg += `Builder: ${builder.active ? escapeHtml(builder.proposal.status || 'active') : 'idle'}\n`;

  if (heartbeat) {
    msg += `\n<b>Heartbeat:</b> ${escapeHtml(heartbeat)}\n`;
  }

  if (last) {
    msg += `\n<b>Last cycle:</b> #${last.cycle} (${last.type})\n`;
    msg += `Day: ${last.day}\n`;
    msg += `Duration: ${last.durationSec}s\n`;
    msg += `Agent exits: [${(last.agentExitCodes || []).join(', ')}]\n`;
    msg += `Post: ${last.postAttempted ? (last.postSuccess ? '✅' : '❌') : '—'}\n`;
    if (last.health) {
      msg += `\nTotal cycles: ${last.health.totalCycles}\n`;
      msg += `Post rate: ${last.health.postSuccessRate ?? 'N/A'}\n`;
      msg += `Posts: ${last.health.totalPostSuccesses}/${last.health.totalPostAttempts}`;
    }
  } else {
    msg += '\n<i>No cycle data yet</i>';
  }
  await sendMessage(msg);
}

async function cmdServices() {
  const runnerState = systemdState('sebastian-runner.service');
  const gatewayState = systemdState('openclaw-gateway.service');
  const botState = systemdState('sebastian-tgbot.service');
  const browserOk = browserResponsive();
  const loops = scraperLoopState();

  let msg = '<b>🧩 Services</b>\n\n';
  msg += `sebastian-runner: ${escapeHtml(runnerState)}\n`;
  msg += `openclaw-gateway: ${escapeHtml(gatewayState)}\n`;
  msg += `sebastian-tgbot: ${escapeHtml(botState)}\n`;
  msg += `browser CDP: ${browserOk ? 'responsive' : 'down'}\n`;
  msg += `scraper loops: ${escapeHtml(loops.map((loop) => `${loop.label}=${loop.running ? 'up' : 'down'}`).join(', '))}\n`;

  await sendMessage(msg);
}

async function cmdHealth() {
  const health = readJSON(path.join(config.STATE_DIR, 'health_state.json'));
  let msg = '<b>🏥 Health State</b>\n\n';
  if (health) {
    for (const [key, val] of Object.entries(health)) {
      msg += `<b>${escapeHtml(key)}:</b> ${typeof val === 'object' ? escapeHtml(JSON.stringify(val)) : escapeHtml(String(val))}\n`;
    }
  } else {
    msg += '<i>No health state file found</i>';
  }
  await sendMessage(msg);
}

async function cmdLast() {
  const lines = readLastLines(config.ORCHESTRATOR_LOG_PATH, 1);
  if (!lines[0]) return sendMessage('<i>No log entries</i>');
  try {
    const entry = JSON.parse(lines[0]);
    await sendMessage(`<pre>${escapeHtml(JSON.stringify(entry, null, 2))}</pre>`);
  } catch {
    await sendMessage(`<pre>${escapeHtml(lines[0])}</pre>`);
  }
}

async function cmdLogs(n = 5) {
  const lines = readLastLines(config.ORCHESTRATOR_LOG_PATH, Math.min(n, 20));
  if (!lines.length) return sendMessage('<i>No log entries</i>');

  let msg = `<b>📋 Last ${lines.length} cycles</b>\n\n`;
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      const exits = (e.agentExitCodes || []).join(',');
      const post = e.postAttempted ? (e.postSuccess ? '✅' : '❌') : '—';
      msg += `#${e.cycle} ${e.type} | ${e.durationSec}s | exits:[${exits}] | post:${post}\n`;
    } catch {
      msg += escapeHtml(line.slice(0, 100)) + '\n';
    }
  }
  await sendMessage(msg);
}

async function cmdOntology() {
  const onto = readJSON(config.ONTOLOGY_PATH);
  if (!onto || !onto.axes) return sendMessage('<i>No ontology data</i>');

  const axes = onto.axes.slice().sort((a, b) => b.confidence - a.confidence);
  let msg = `<b>🧠 Ontology — ${axes.length} axes</b>\n\n`;
  const top = axes.slice(0, 10);
  for (const ax of top) {
    const dir = ax.score > 0 ? '→' : ax.score < 0 ? '←' : '·';
    msg += `${dir} <b>${escapeHtml(ax.label)}</b>\n`;
    msg += `  score: ${ax.score.toFixed(2)} | conf: ${ax.confidence.toFixed(2)}\n`;
  }
  if (axes.length > 10) msg += `\n<i>...and ${axes.length - 10} more</i>`;
  await sendMessage(msg);
}

async function cmdPosts() {
  const log = readJSON(config.POSTS_LOG_PATH);
  if (!log || !log.posts || !log.posts.length) return sendMessage('<i>No posts yet</i>');

  const recent = log.posts.slice(-5);
  let msg = `<b>📝 Recent Posts (${log.total_posts} total)</b>\n\n`;
  for (const p of recent) {
    msg += `<b>[${p.type}]</b> ${p.date || p.posted_at?.slice(0, 10) || ''}\n`;
    msg += `${escapeHtml((p.content || p.text || '').slice(0, 120))}\n`;
    if (p.tweet_url && p.tweet_url !== 'posted') msg += `${p.tweet_url}\n`;
    msg += '\n';
  }
  await sendMessage(msg);
}

async function cmdJournal() {
  // Find latest journal file
  try {
    const files = fs.readdirSync(config.JOURNALS_DIR)
      .filter(f => f.endsWith('.html'))
      .sort()
      .reverse();
    if (!files.length) return sendMessage('<i>No journals yet</i>');

    const latest = files[0];
    const name = latest.replace('.html', '');
    const [date, hour] = name.split('_');
    const content = readText(path.join(config.JOURNALS_DIR, latest));

    // Extract text from stream section (strip HTML tags)
    const streamMatch = content.match(/<section class="stream">([\s\S]*?)<\/section>/);
    const streamText = streamMatch
      ? streamMatch[1].replace(/<[^>]+>/g, '').trim().slice(0, 600)
      : content.replace(/<[^>]+>/g, '').trim().slice(0, 600);

    let msg = `<b>📓 Latest Journal</b>\n`;
    msg += `${date} ${hour}:00\n\n`;
    msg += escapeHtml(streamText);
    msg += `\n\n<a href="https://sebastianhunter.fun/journal/${date}/${hour}">View full</a>`;
    await sendMessage(msg);
  } catch (e) {
    await sendMessage(`<i>Error reading journal: ${e.message}</i>`);
  }
}

async function cmdVocation() {
  const voc = readJSON(path.join(config.STATE_DIR, 'vocation.json'));
  if (!voc) return sendMessage('<i>No vocation data</i>');

  let msg = `<b>🎯 Vocation</b>\n\n`;
  msg += `Status: <b>${voc.status}</b>\n`;
  if (voc.label) msg += `Label: ${escapeHtml(voc.label)}\n`;
  if (voc.description) msg += `\n${escapeHtml(voc.description)}\n`;
  if (voc.intent) msg += `\n<b>Intent:</b> ${escapeHtml(voc.intent.slice(0, 300))}\n`;
  if (voc.core_axes) msg += `\nCore axes: ${voc.core_axes.join(', ')}\n`;
  if (voc.last_updated) msg += `\nUpdated: ${voc.last_updated}`;
  await sendMessage(msg);
}

async function cmdVM() {
  const uptime = shell('uptime -p 2>/dev/null || uptime');
  const memRaw = shell('free -m 2>/dev/null');
  const diskRaw = shell('df -h / 2>/dev/null | tail -1');
  const loadAvg = shell('cat /proc/loadavg 2>/dev/null');
  const cpuCount = shell('nproc 2>/dev/null');

  // Parse memory
  let memLine = '';
  if (memRaw) {
    const lines = memRaw.split('\n');
    const memRow = lines.find(l => l.startsWith('Mem:'));
    if (memRow) {
      const parts = memRow.split(/\s+/);
      const total = parts[1] || '?';
      const used = parts[2] || '?';
      const available = parts[6] || parts[3] || '?';
      memLine = `${used}MB / ${total}MB (${available}MB free)`;
    }
  }

  // Parse disk
  let diskLine = '';
  if (diskRaw) {
    const parts = diskRaw.split(/\s+/);
    diskLine = `${parts[2] || '?'} / ${parts[1] || '?'} (${parts[4] || '?'} used)`;
  }

  // Check key processes  
  const orchPid = shell('pgrep -f "node.*orchestrator" 2>/dev/null');
  const chromePid = shell('pgrep -f "chrome.*remote-debugging" 2>/dev/null');
  const scraperPid = shell('pgrep -f "collect.js|reply.js|follows.js" 2>/dev/null');

  let msg = '<b>🖥 VM Status</b>\n\n';
  msg += `Uptime: ${escapeHtml(uptime)}\n`;
  msg += `Load: ${loadAvg || 'N/A'} (${cpuCount || '?'} cores)\n`;
  msg += `Memory: ${memLine || 'N/A'}\n`;
  msg += `Disk: ${diskLine || 'N/A'}\n`;
  msg += `\n<b>Processes:</b>\n`;
  msg += `Orchestrator: ${orchPid ? '🟢 PID ' + orchPid.split('\n')[0] : '🔴 not running'}\n`;
  msg += `Chrome: ${chromePid ? '🟢 PID ' + chromePid.split('\n')[0] : '🔴 not running'}\n`;
  msg += `Scraper: ${scraperPid ? '🟢 running' : '🔴 not running'}\n`;
  msg += `TG Bot: 🟢 up ${humanDuration(Date.now() - STARTED_AT.getTime())}`;
  await sendMessage(msg);
}

async function cmdErrors() {
  // Get recent errors from journalctl
  const errors = shell(
    'journalctl -u sebastian-runner --no-pager --since "1 hour ago" --priority=err 2>/dev/null | tail -15',
    15000,
  );
  // Also check runner.log for recent errors/failures
  const runnerErrors = shell(
    'grep -i "error\\|fail\\|crash\\|timeout\\|FATAL" ' +
    `"${config.RUNNER_LOG_PATH}" 2>/dev/null | tail -10`,
    10000,
  );

  let msg = '<b>⚠️ Recent Errors</b>\n\n';

  if (errors) {
    msg += '<b>systemd (last 1h):</b>\n';
    msg += `<pre>${escapeHtml(errors.slice(0, 1500))}</pre>\n\n`;
  }

  if (runnerErrors) {
    msg += '<b>runner.log:</b>\n';
    msg += `<pre>${escapeHtml(runnerErrors.slice(0, 1500))}</pre>`;
  }

  if (!errors && !runnerErrors) {
    msg += '✅ No recent errors found';
  }

  await sendMessage(msg);
}

async function cmdDrift() {
  const driftPath = config.SIGNAL_LOG_PATH || path.join(config.STATE_DIR, 'signal_log.jsonl');
  const alertsPath = path.join(config.STATE_DIR, 'drift_alerts.jsonl');

  let msg = '<b>📈 Drift & Signals</b>\n\n';

  // Recent signal log entries
  const signalLines = readLastLines(driftPath, 3);
  if (signalLines.length) {
    msg += '<b>Recent signals:</b>\n';
    for (const line of signalLines) {
      try {
        const s = JSON.parse(line);
        msg += `${s.ts?.slice(0, 16) || '?'} | strength: ${s.strength} | ${s.spike_count} axes spiked\n`;
      } catch {
        msg += escapeHtml(line.slice(0, 80)) + '\n';
      }
    }
    msg += '\n';
  }

  // Recent drift alerts
  const alertLines = readLastLines(alertsPath, 5);
  if (alertLines.length) {
    msg += '<b>Recent drift alerts:</b>\n';
    for (const line of alertLines) {
      try {
        const a = JSON.parse(line);
        msg += `${a.axis_id || a.id || '?'}: dir=${a.direction || '?'} Δ=${(a.cusum_value || a.delta || 0).toFixed(3)}\n`;
      } catch {
        msg += escapeHtml(line.slice(0, 80)) + '\n';
      }
    }
  }

  if (!signalLines.length && !alertLines.length) {
    msg += '<i>No drift data yet</i>';
  }

  await sendMessage(msg);
}

async function cmdBuilder(rawText = '') {
  const parts = rawText.split(/\s+/).filter(Boolean);
  const subcmd = (parts[1] || '').toLowerCase();

  if (!subcmd || subcmd === 'status') {
    return sendMessage(buildBuilderStatusMessage());
  }

  if (subcmd === 'ask') {
    const question = rawText.replace(/^\/builder\s+ask\s+/i, '').trim();
    if (!question) {
      return sendMessage('Usage: <code>/builder ask what are you working on?</code>');
    }
    await sendTyping();
    const result = runBuilderQuestion(question);
    if (!result.ok) {
      return sendMessage(`❌ ${escapeHtml(result.error)}`);
    }
    return sendMessage(`<b>🛠 Builder</b>\n\n${escapeHtml(result.text)}`);
  }

  return sendMessage(
    'Usage:\n' +
    '<code>/builder</code> — status\n' +
    '<code>/builder ask &lt;question&gt;</code> — ask about the active proposal',
  );
}

async function cmdCycle() {
  // Read last structured log to get current cycle number
  const lines = readLastLines(config.ORCHESTRATOR_LOG_PATH, 1);
  const last = lines[0] ? (() => { try { return JSON.parse(lines[0]); } catch { return null; } })() : null;

  const heartbeat = readText(config.HEARTBEAT_PATH);
  const paused = fs.existsSync(config.PAUSE_FILE);

  // Extract current cycle from heartbeat (format: "cycle: N | type: X | YYYY-MM-DD HH:MM")
  let currentCycle = last?.cycle || 0;
  const hbMatch = heartbeat.match(/cycle:\s*(\d+)/);
  if (hbMatch) currentCycle = parseInt(hbMatch[1], 10);

  // Timing constants
  const interval = config.BROWSE_INTERVAL; // seconds between cycles
  const tweetEvery = config.TWEET_EVERY;   // tweet on every Nth cycle
  const quoteOffset = config.QUOTE_OFFSET; // quote on cycle N where N % tweetEvery === quoteOffset
  const tweetStart = config.TWEET_START;   // earliest hour (UTC) for posts
  const tweetEnd = config.TWEET_END;       // latest hour (UTC) for posts

  // Estimate when last cycle ended (from structured log timestamp)
  let lastCycleEnd = null;
  if (last?.ts) lastCycleEnd = new Date(last.ts);

  const now = new Date();

  let msg = '<b>⏱ Cycle Schedule</b>\n\n';

  if (paused) {
    msg += '⏸ <b>PAUSED</b> — orchestrator is paused\n\n';
  }

  msg += `Current cycle: <b>${currentCycle}</b>\n`;
  msg += `Interval: ${interval}s (${(interval / 60).toFixed(0)}min)\n`;
  msg += `Tweet every: ${tweetEvery} cycles (~${((tweetEvery * interval) / 3600).toFixed(1)}h)\n`;
  msg += `Quote offset: cycle % ${tweetEvery} === ${quoteOffset}\n`;
  msg += `Post window: ${tweetStart}:00–${tweetEnd}:00 UTC\n\n`;

  // Show next 8 cycles
  msg += '<b>Upcoming cycles:</b>\n';
  const startCycle = currentCycle + 1;
  let nextTime = lastCycleEnd ? new Date(lastCycleEnd.getTime() + interval * 1000) : new Date(now.getTime() + 60_000);

  // If nextTime is in the past, snap forward
  if (nextTime < now) {
    const elapsed = Math.floor((now - nextTime) / 1000);
    const skip = Math.ceil(elapsed / interval);
    nextTime = new Date(nextTime.getTime() + skip * interval * 1000);
  }

  for (let i = 0; i < 8; i++) {
    const c = startCycle + i;
    const cycleTime = new Date(nextTime.getTime() + i * interval * 1000);
    const hh = String(cycleTime.getUTCHours()).padStart(2, '0');
    const mm = String(cycleTime.getUTCMinutes()).padStart(2, '0');
    const cycleHour = cycleTime.getUTCHours();
    const inWindow = cycleHour >= tweetStart && cycleHour < tweetEnd;

    let type;
    if (c % tweetEvery === 0) {
      type = inWindow ? '🐦 TWEET' : '👁 BROWSE (tweet window closed)';
    } else if (c % tweetEvery === quoteOffset) {
      type = inWindow ? '💬 QUOTE' : '👁 BROWSE (quote window closed)';
    } else {
      type = '👁 BROWSE';
    }

    const relative = Math.max(0, Math.floor((cycleTime - now) / 60_000));
    const relStr = relative === 0 ? 'now' : `in ${relative}m`;
    msg += `  #${c} ${hh}:${mm} UTC — ${type} (${relStr})\n`;
  }

  msg += `\n<i>Times are estimates based on ${interval}s intervals</i>`;
  await sendMessage(msg);
}

async function cmdRestart(rawText = '') {
  const target = (rawText.split(/\s+/)[1] || 'browser').toLowerCase();

  if (isCycleLocked()) {
    return sendMessage('⚠️ Cycle is running — try again after it finishes.');
  }

  const allowed = new Set(['browser', 'runner', 'gateway', 'scraper', 'all']);
  if (!allowed.has(target)) {
    return sendMessage('Usage: <code>/restart browser|runner|gateway|scraper|all</code>');
  }

  await sendMessage(`🔄 Restarting ${escapeHtml(target)}...`);

  if (target === 'browser') {
    const ok = restartBrowserProfile();
    return sendMessage(ok ? '✅ Browser restarted and responding' : '❌ Browser restart failed — CDP still down');
  }

  if (target === 'scraper') {
    const result = restartScraperLoops();
    const loops = result.loops.map((loop) => `${loop.label}=${loop.running ? 'up' : 'down'}`).join(', ');
    return sendMessage(
      result.ok
        ? `✅ Scraper restarted\n${escapeHtml(loops)}`
        : `❌ Scraper restart failed\n${escapeHtml(result.start.stderr || result.stop.stderr || loops)}`,
    );
  }

  if (target === 'gateway') {
    const result = sudoSystemctl('restart', 'openclaw-gateway.service');
    if (!result.ok) {
      return sendMessage(`❌ Gateway restart failed\n<pre>${escapeHtml(result.stderr.slice(0, 600))}</pre>`);
    }
    return sendMessage('✅ openclaw-gateway.service restarted');
  }

  if (target === 'runner') {
    const result = sudoSystemctl('restart', 'sebastian-runner.service');
    if (!result.ok) {
      return sendMessage(`❌ Runner restart failed\n<pre>${escapeHtml(result.stderr.slice(0, 600))}</pre>`);
    }
    return sendMessage('✅ sebastian-runner.service restarted');
  }

  const gatewayResult = sudoSystemctl('restart', 'openclaw-gateway.service');
  const runnerResult = sudoSystemctl('restart', 'sebastian-runner.service');
  const browserOk = restartBrowserProfile();
  const scraperResult = restartScraperLoops();

  let msg = '<b>🔄 Restart all</b>\n\n';
  msg += `Gateway: ${gatewayResult.ok ? 'ok' : 'failed'}\n`;
  msg += `Runner: ${runnerResult.ok ? 'ok' : 'failed'}\n`;
  msg += `Browser: ${browserOk ? 'ok' : 'failed'}\n`;
  msg += `Scraper: ${scraperResult.ok ? 'ok' : 'failed'}\n`;
  if (!gatewayResult.ok) msg += `\nGateway error: ${escapeHtml(gatewayResult.stderr.slice(0, 240))}\n`;
  if (!runnerResult.ok) msg += `Runner error: ${escapeHtml(runnerResult.stderr.slice(0, 240))}\n`;
  return sendMessage(msg);
}

async function cmdTroubleshoot(rawText = '') {
  const wantsFix = /\bfix\b/i.test(rawText);
  const report = collectTroubleshootingFindings();

  if (!wantsFix) {
    return sendMessage(formatTroubleshootingReport(report));
  }

  if (isCycleLocked()) {
    return sendMessage(
      formatTroubleshootingReport(report) +
      '\n\n⚠️ Fix mode skipped because a cycle is currently running.',
    );
  }

  const fixes = [];

  for (const finding of report.findings) {
    if (finding.fix === 'runner') {
      const result = sudoSystemctl('restart', 'sebastian-runner.service');
      fixes.push(result.ok ? 'Restarted sebastian-runner.service' : `Runner restart failed: ${result.stderr.slice(0, 200)}`);
    } else if (finding.fix === 'gateway') {
      const result = sudoSystemctl('restart', 'openclaw-gateway.service');
      fixes.push(result.ok ? 'Restarted openclaw-gateway.service' : `Gateway restart failed: ${result.stderr.slice(0, 200)}`);
    } else if (finding.fix === 'browser') {
      const ok = restartBrowserProfile();
      fixes.push(ok ? 'Restarted browser profile x-hunter' : 'Browser restart failed');
    } else if (finding.fix === 'scraper' && report.runnerState === 'active') {
      const result = restartScraperLoops();
      fixes.push(result.ok ? 'Restarted scraper loops' : `Scraper restart failed: ${(result.start.stderr || '').slice(0, 200)}`);
    }
  }

  const after = collectTroubleshootingFindings();
  return sendMessage(formatTroubleshootingReport(after, fixes));
}

async function cmdPause() {
  try {
    fs.writeFileSync(config.PAUSE_FILE, new Date().toISOString());
    await sendMessage('⏸ Orchestrator paused. Send /resume to continue.');
  } catch (e) {
    await sendMessage(`❌ Failed to pause: ${e.message}`);
  }
}

async function cmdResume() {
  try {
    if (fs.existsSync(config.PAUSE_FILE)) fs.unlinkSync(config.PAUSE_FILE);
    await sendMessage('▶️ Orchestrator resumed.');
  } catch (e) {
    await sendMessage(`❌ Failed to resume: ${e.message}`);
  }
}

// ── Chat with OpenClaw ──────────────────────────────────────────────────────

async function chatWithAgent(userMessage) {
  if (isCycleLocked()) {
    return sendMessage(
      '⏳ A cycle is running right now. Your message will be processed after it finishes.\n\n' +
      '<i>Queued: ' + escapeHtml(userMessage.slice(0, 200)) + '</i>',
    );
  }

  await sendTyping();

  const prompt = [
    'You are Sebastian D. Hunter, responding to a message from your operator via Telegram.',
    'Keep your response concise (under 500 chars ideally). Be direct and helpful.',
    'You have access to the browser and can look things up if needed.',
    '',
    `Operator message: ${userMessage}`,
  ].join('\n');

  try {
    // Write cycle lock to prevent orchestrator overlap
    fs.writeFileSync(CYCLE_LOCK_PATH, JSON.stringify({
      source: 'telegram_bot',
      started: new Date().toISOString(),
    }));

    const result = spawnSync('openclaw', [
      'agent',
      '--agent', 'x-hunter',
      '--message', prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      timeout: AGENT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });

    // Release lock
    try { fs.unlinkSync(CYCLE_LOCK_PATH); } catch {}

    if (result.signal === 'SIGKILL') {
      return sendMessage('⏱ Agent timed out (5 min limit).');
    }

    const stdout = (result.stdout || '').toString().trim();
    const stderr = (result.stderr || '').toString().trim();

    if (result.status !== 0) {
      console.log(`[tgbot] agent exited ${result.status}: ${stderr.slice(0, 200)}`);
      return sendMessage(
        '❌ Agent returned an error.\n\n' +
        `<pre>${escapeHtml((stderr || stdout || 'Unknown error').slice(0, 500))}</pre>`,
      );
    }

    // Extract the agent's final response (last meaningful content)
    const response = stdout || '<i>Agent completed but produced no output</i>';
    await sendMessage(response.slice(0, 4000));

  } catch (e) {
    try { fs.unlinkSync(CYCLE_LOCK_PATH); } catch {}
    await sendMessage(`❌ Error: ${e.message}`);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Message router ──────────────────────────────────────────────────────────

async function handleMessage(msg) {
  // Only respond to our authorized chat
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  const text = (msg.text || '').trim();
  if (!text) return;

  console.log(`[tgbot] received: ${text.slice(0, 100)}`);

  // Route commands
  const cmd = text.toLowerCase().split(/\s+/)[0];

  switch (cmd) {
    case '/status':   return cmdStatus();
    case '/services': return cmdServices();
    case '/health':   return cmdHealth();
    case '/last':     return cmdLast();
    case '/logs': {
      const n = parseInt(text.split(/\s+/)[1], 10) || 5;
      return cmdLogs(n);
    }
    case '/ontology': return cmdOntology();
    case '/posts':    return cmdPosts();
    case '/journal':  return cmdJournal();
    case '/vocation': return cmdVocation();
    case '/builder':  return cmdBuilder(text);
    case '/vm':       return cmdVM();
    case '/errors':   return cmdErrors();
    case '/drift':    return cmdDrift();
    case '/cycle':    return cmdCycle();
    case '/restart':  return cmdRestart(text);
    case '/troubleshoot':
    case '/doctor':   return cmdTroubleshoot(text);
    case '/pause':    return cmdPause();
    case '/resume':   return cmdResume();
    case '/start':
    case '/help':     return sendMessage(
      '<b>📖 Sebastian Hunter — Commands</b>\n\n' +
      '<b>Monitoring:</b>\n' +
      '/status — orchestrator overview\n' +
      '/services — runner/gateway/bot/browser/scraper status\n' +
      '/health — browser + agent health\n' +
      '/vm — VM resources (CPU, RAM, disk)\n' +
      '/errors — recent errors\n' +
      '/last — last cycle (full JSON)\n' +
      '/logs N — last N cycles summary\n' +
      '/cycle — upcoming cycle schedule\n' +
      '/troubleshoot — diagnose issues\n' +
      '/troubleshoot fix — diagnose + apply safe fixes\n' +
      '\n<b>Content:</b>\n' +
      '/ontology — belief axes overview\n' +
      '/posts — recent X posts\n' +
      '/journal — latest journal entry\n' +
      '/vocation — current vocation\n' +
      '/drift — recent drift alerts\n' +
      '/builder — active builder proposal\n' +
      '/builder ask ... — ask builder about the active proposal\n' +
      '\n<b>Control:</b>\n' +
      '/restart browser|runner|gateway|scraper|all\n' +
      '/pause — pause orchestrator\n' +
      '/resume — resume orchestrator\n' +
      '\n<i>Any other text → chat with Sebastian via OpenClaw</i>',
    );
    default:
      // Forward to OpenClaw agent as chat
      return chatWithAgent(text);
  }
}

// ── Poll loop ───────────────────────────────────────────────────────────────

async function poll() {
  try {
    const result = await telegramAPI('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 30,  // long-poll: Telegram holds connection for 30s
      allowed_updates: ['message'],
    });

    if (result.ok && result.result && result.result.length > 0) {
      for (const update of result.result) {
        lastUpdateId = update.update_id;
        if (update.message) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (e) {
    console.log(`[tgbot] poll error: ${e.message}`);
    await sleep(5000); // back off on error
  }

  // Schedule next poll
  setTimeout(poll, POLL_INTERVAL);
}

// ── Startup ─────────────────────────────────────────────────────────────────

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[tgbot] FATAL: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set');
  process.exit(1);
}

console.log('[tgbot] Sebastian Hunter Telegram bot starting...');
console.log(`[tgbot] Chat ID: ${CHAT_ID}`);
console.log(`[tgbot] Polling interval: ${POLL_INTERVAL}ms`);
console.log('[tgbot] Ready for commands.');

// Send startup notification
sendMessage('🤖 <b>Telegram bot started</b>\nSend /help for commands.').then(() => {
  // Start polling
  poll();
});
