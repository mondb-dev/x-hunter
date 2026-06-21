'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('./config');

const SANDBOX_WORKSPACE = '/workspace';
const SANDBOX_STATE_DIR = `${SANDBOX_WORKSPACE}/state`;
const SANDBOX_RUNNER_DIR = `${SANDBOX_WORKSPACE}/runner`;
const SANDBOX_TOOLS_DIR = `${SANDBOX_WORKSPACE}/tools`;

function log(msg) {
  console.log(`[sandbox] ${msg}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function posixify(value) {
  return String(value || '').replace(/\\/g, '/');
}

function normalizeStateRelativePath(relPath) {
  if (typeof relPath !== 'string') return null;
  const trimmed = posixify(relPath.trim());
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.startsWith('/')) return null;
  const clean = path.posix.normalize(trimmed);
  if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) return null;
  return clean;
}

function normalizeStatePattern(pattern) {
  if (typeof pattern !== 'string') return null;
  let clean = posixify(pattern.trim());
  if (!clean || clean.includes('\0')) return null;
  if (clean.startsWith('/')) return null;
  if (clean.startsWith('./')) clean = clean.slice(2);
  const wildcard = clean.endsWith('/**');
  if (clean.includes('*') && !wildcard) return null;
  const base = wildcard ? clean.slice(0, -3) : clean;
  const normalizedBase = path.posix.normalize(base.endsWith('/') ? base.slice(0, -1) : base);
  if (normalizedBase === '.' || normalizedBase === '..' || normalizedBase.startsWith('../')) return null;
  if (normalizedBase !== 'state' && !normalizedBase.startsWith('state/')) return null;
  if (normalizedBase === 'state' && !wildcard) return null;
  return wildcard ? `${normalizedBase}/**` : normalizedBase;
}

function validateCapabilities(capabilities) {
  const errors = [];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return { valid: false, errors: ['missing or invalid "capabilities" export'] };
  }

  for (const field of ['read', 'write']) {
    if (!Array.isArray(capabilities[field])) {
      errors.push(`capabilities.${field} must be an array`);
      continue;
    }
    for (const entry of capabilities[field]) {
      if (!normalizeStatePattern(entry)) {
        errors.push(`invalid capability pattern in capabilities.${field}: ${JSON.stringify(entry)}`);
      }
    }
  }

  if (capabilities.call_tools !== undefined) {
    if (!Array.isArray(capabilities.call_tools)) {
      errors.push('capabilities.call_tools must be an array when provided');
    } else {
      for (const toolName of capabilities.call_tools) {
        if (typeof toolName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(toolName)) {
          errors.push(`invalid tool name in capabilities.call_tools: ${JSON.stringify(toolName)}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function matchesStatePattern(stateRelPath, pattern) {
  const rel = normalizeStateRelativePath(stateRelPath);
  const normalizedPattern = normalizeStatePattern(pattern);
  if (!rel || !normalizedPattern) return false;
  const relWithPrefix = `state/${rel}`;
  if (normalizedPattern === 'state/**') return true;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return relWithPrefix === prefix || relWithPrefix.startsWith(`${prefix}/`);
  }
  return relWithPrefix === normalizedPattern;
}

function matchesAnyPattern(stateRelPath, patterns) {
  return (patterns || []).some(pattern => matchesStatePattern(stateRelPath, pattern));
}

function absoluteStatePathToRelative(filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const abs = path.resolve(filePath);
  const stateRoot = path.resolve(config.STATE_DIR);
  const rel = path.relative(stateRoot, abs);
  return normalizeStateRelativePath(rel);
}

function resolveRequestedStatePath(filePath, stateRoot) {
  if (typeof filePath !== 'string') throw new Error('state path must be a string');
  if (path.isAbsolute(filePath)) {
    const abs = path.resolve(filePath);
    const rel = path.relative(stateRoot, abs);
    const cleanRel = normalizeStateRelativePath(rel);
    if (!cleanRel) {
      throw new Error(`Path is outside state/: ${filePath}`);
    }
    return path.join(stateRoot, cleanRel);
  }

  let rel = posixify(filePath.trim());
  if (rel.startsWith('state/')) rel = rel.slice('state/'.length);
  const cleanRel = normalizeStateRelativePath(rel);
  if (!cleanRel) {
    throw new Error(`Invalid state path: ${filePath}`);
  }
  return path.join(stateRoot, cleanRel);
}

function collectFilesRecursive(rootDir, baseDir = rootDir, out = new Map()) {
  if (!fs.existsSync(rootDir)) return out;
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(rootDir, entry.name);
    const relPath = path.relative(baseDir, absPath);
    if (entry.isDirectory()) {
      collectFilesRecursive(absPath, baseDir, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const cleanRel = normalizeStateRelativePath(relPath);
    if (!cleanRel || cleanRel.startsWith('sandboxes/')) continue;
    out.set(cleanRel, fs.readFileSync(absPath));
  }
  return out;
}

function copyFileIntoScratch(liveRoot, scratchRoot, stateRelPath) {
  const livePath = path.join(liveRoot, stateRelPath);
  if (!fs.existsSync(livePath) || !fs.statSync(livePath).isFile()) return;
  const scratchPath = path.join(scratchRoot, stateRelPath);
  ensureDir(path.dirname(scratchPath));
  fs.copyFileSync(livePath, scratchPath);
}

function copyPatternIntoScratch(pattern, liveRoot, scratchRoot) {
  if (pattern === 'state/**') {
    const snapshot = collectFilesRecursive(liveRoot);
    for (const relPath of snapshot.keys()) {
      copyFileIntoScratch(liveRoot, scratchRoot, relPath);
    }
    return;
  }

  if (pattern.endsWith('/**')) {
    const relPrefix = pattern.slice('state/'.length, -3);
    const liveDir = path.join(liveRoot, relPrefix);
    const snapshot = collectFilesRecursive(liveDir, liveDir);
    for (const relPath of snapshot.keys()) {
      copyFileIntoScratch(liveRoot, scratchRoot, path.posix.join(relPrefix, relPath));
    }
    return;
  }

  copyFileIntoScratch(liveRoot, scratchRoot, pattern.slice('state/'.length));
}

function atomicWriteFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tmpPath = path.join(
    path.dirname(filePath),
    `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function createRunId(toolName) {
  const clean = String(toolName || 'tool').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'tool';
  return `${Date.now()}-${clean}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildSandboxMeta(runId, toolName, runDir) {
  return {
    run_id: runId,
    tool: toolName,
    started_at: new Date().toISOString(),
    pid: null,
    pgid: null,
    status: 'starting',
    temp_root: runDir,
  };
}

function writeMeta(metaPath, meta) {
  atomicWriteFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

function killProcessGroup(pid, signal) {
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

function reapStaleSandboxes() {
  ensureDir(config.SANDBOXES_DIR);
  const now = Date.now();
  const entries = fs.readdirSync(config.SANDBOXES_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(config.SANDBOXES_DIR, entry.name);
    const metaPath = path.join(runDir, 'meta.json');
    let shouldDelete = false;
    try {
      const stat = fs.statSync(runDir);
      shouldDelete = now - stat.mtimeMs > config.SANDBOX_REAP_MAX_AGE_MS;
    } catch {
      shouldDelete = true;
    }
    if (!shouldDelete) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      killProcessGroup(meta.pgid || meta.pid, 'SIGTERM');
      killProcessGroup(meta.pgid || meta.pid, 'SIGKILL');
    } catch {}
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
      log(`reaped stale sandbox ${entry.name}`);
    } catch (e) {
      log(`failed to reap sandbox ${entry.name}: ${e.message}`);
    }
  }
}

function prepareScratchState(readPatterns, writePatterns, scratchStateDir) {
  ensureDir(scratchStateDir);
  const allPatterns = Array.from(new Set([...(readPatterns || []), ...(writePatterns || [])]));
  for (const pattern of allPatterns) {
    copyPatternIntoScratch(pattern, config.STATE_DIR, scratchStateDir);
  }
  return collectFilesRecursive(scratchStateDir);
}

function validateAndPromoteWrites(scratchStateDir, baseline, writePatterns) {
  const current = collectFilesRecursive(scratchStateDir);
  const changed = [];
  const violations = [];

  for (const [relPath, content] of current.entries()) {
    const before = baseline.get(relPath);
    const isChanged = !before || !before.equals(content);
    if (!isChanged) continue;
    if (!matchesAnyPattern(relPath, writePatterns)) {
      violations.push(`unauthorized write: state/${relPath}`);
      continue;
    }
    changed.push(relPath);
  }

  for (const [relPath] of baseline.entries()) {
    if (current.has(relPath)) continue;
    violations.push(`deletion not allowed: state/${relPath}`);
  }

  if (violations.length > 0) {
    throw new Error(`Sandbox write violations: ${violations.slice(0, 6).join('; ')}`);
  }

  for (const relPath of changed) {
    const content = current.get(relPath);
    atomicWriteFile(path.join(config.STATE_DIR, relPath), content);
  }

  return changed.map(relPath => `state/${relPath}`);
}

function collectOutput(stream, logPath, maxBytes) {
  return new Promise(resolve => {
    if (!stream) return resolve('');
    const chunks = [];
    let bytes = 0;
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    stream.on('data', chunk => {
      logStream.write(chunk);
      if (bytes < maxBytes) {
        chunks.push(chunk);
        bytes += chunk.length;
      }
    });
    stream.on('close', () => {
      logStream.end();
      resolve(Buffer.concat(chunks, Math.min(bytes, maxBytes)).toString('utf-8'));
    });
  });
}

function buildNodeOptions() {
  return `--max-old-space-size=${config.SANDBOX_MAX_OLD_SPACE_MB} --require=${SANDBOX_RUNNER_DIR}/tool_guard.js`;
}

function pushReadonlySystemMounts(args) {
  for (const systemPath of ['/usr', '/bin', '/etc', '/lib', '/lib64', '/sbin']) {
    if (fs.existsSync(systemPath)) {
      args.push('--ro-bind', systemPath, systemPath);
    }
  }
}

function spawnSandboxedProcess({ runDir, toolName, encodedArgs, timeoutMs, metaPath, meta }) {
  return new Promise((resolve, reject) => {
    const scratchStateDir = path.join(runDir, 'work', 'state');
    const logsDir = path.join(runDir, 'logs');
    ensureDir(logsDir);

    const bubblewrapArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'NODE_OPTIONS', buildNodeOptions(),
      '--setenv', 'TOOL_SANDBOX', '1',
      '--setenv', 'CYCLE', process.env.CYCLE || '0',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--dir', SANDBOX_WORKSPACE,
      '--dir', SANDBOX_RUNNER_DIR,
      '--dir', SANDBOX_TOOLS_DIR,
      '--ro-bind', config.RUNNER_DIR, SANDBOX_RUNNER_DIR,
      '--ro-bind', config.TOOLS_DIR, SANDBOX_TOOLS_DIR,
      '--bind', scratchStateDir, SANDBOX_STATE_DIR,
      '--chdir', SANDBOX_WORKSPACE,
    ];

    pushReadonlySystemMounts(bubblewrapArgs);

    bubblewrapArgs.push(
      process.execPath,
      `${SANDBOX_RUNNER_DIR}/tool_runner.js`,
      toolName,
      encodedArgs
    );

    const child = spawn('bwrap', bubblewrapArgs, {
      cwd: config.PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    meta.pid = child.pid;
    meta.pgid = child.pid;
    meta.status = 'running';
    writeMeta(metaPath, meta);

    const stdoutPromise = collectOutput(
      child.stdout,
      path.join(logsDir, 'stdout.log'),
      config.SANDBOX_STDIO_MAX_BYTES
    );
    const stderrPromise = collectOutput(
      child.stderr,
      path.join(logsDir, 'stderr.log'),
      config.SANDBOX_STDIO_MAX_BYTES
    );

    let timedOut = false;
    let killTimer = null;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcessGroup(child.pid, 'SIGKILL');
      }, 1500);
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      reject(err);
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function executeSandboxedTool({ toolName, args, readPatterns, writePatterns }) {
  if (!toolName) {
    throw new Error('executeSandboxedTool requires toolName');
  }

  if (!fs.existsSync('/usr/bin/bwrap')) {
    return {
      tool: toolName,
      status: 'error',
      error: 'bubblewrap is not installed on this host',
      duration_ms: 0,
    };
  }

  reapStaleSandboxes();
  ensureDir(config.SANDBOXES_DIR);

  const runId = createRunId(toolName);
  const runDir = path.join(config.SANDBOXES_DIR, runId);
  const scratchStateDir = path.join(runDir, 'work', 'state');
  const metaPath = path.join(runDir, 'meta.json');
  const meta = buildSandboxMeta(runId, toolName, runDir);
  const start = Date.now();

  ensureDir(runDir);
  writeMeta(metaPath, meta);

  let baseline = new Map();
  try {
    baseline = prepareScratchState(readPatterns, writePatterns, scratchStateDir);
    const encodedArgs = Buffer.from(JSON.stringify(args || {}), 'utf-8').toString('base64');
    const proc = await spawnSandboxedProcess({
      runDir,
      toolName,
      encodedArgs,
      timeoutMs: config.TOOL_TIMEOUT_MS,
      metaPath,
      meta,
    });

    if (proc.timedOut) {
      meta.status = 'timed_out';
      writeMeta(metaPath, meta);
      return {
        tool: toolName,
        status: 'error',
        error: `Tool timed out after ${config.TOOL_TIMEOUT_MS}ms`,
        duration_ms: Date.now() - start,
      };
    }

    if (proc.code !== 0) {
      meta.status = 'failed';
      writeMeta(metaPath, meta);
      const errText = proc.stderr.trim() || `sandbox exited with code ${proc.code}${proc.signal ? ` (${proc.signal})` : ''}`;
      return {
        tool: toolName,
        status: 'error',
        error: `Sandbox runner failed: ${errText.slice(0, 200)}`,
        duration_ms: Date.now() - start,
      };
    }

    let result;
    try {
      result = JSON.parse(proc.stdout.trim() || '');
    } catch (e) {
      meta.status = 'failed';
      writeMeta(metaPath, meta);
      return {
        tool: toolName,
        status: 'error',
        error: `Sandbox returned invalid JSON: ${e.message}`,
        duration_ms: Date.now() - start,
      };
    }

    const promotedWrites = validateAndPromoteWrites(scratchStateDir, baseline, writePatterns);
    meta.status = 'completed';
    meta.promoted_writes = promotedWrites;
    writeMeta(metaPath, meta);

    result.tool = result.tool || toolName;
    result.duration_ms = result.duration_ms || (Date.now() - start);
    if (promotedWrites.length > 0) {
      result.promoted_writes = promotedWrites;
    }
    return result;
  } finally {
    try {
      killProcessGroup(meta.pgid || meta.pid, 'SIGTERM');
      killProcessGroup(meta.pgid || meta.pid, 'SIGKILL');
    } catch {}
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}
  }
}

module.exports = {
  absoluteStatePathToRelative,
  buildNodeOptions,
  executeSandboxedTool,
  matchesAnyPattern,
  matchesStatePattern,
  normalizeStatePattern,
  normalizeStateRelativePath,
  pushReadonlySystemMounts,
  reapStaleSandboxes,
  resolveRequestedStatePath,
  validateCapabilities,
};
