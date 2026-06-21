'use strict';

/**
 * runner/lib/tools.js — Tool discovery, validation, and execution engine
 *
 * Sebastian can request tool execution by writing state/tool_request.json
 * during any agent run. The orchestrator calls executeToolRequest() after
 * the agent completes. Results appear in state/tool_result.json next cycle.
 *
 * Tools live in tools/*.js and must export: name, description, execute(args, ctx).
 * The builder agent creates new tools via the META cycle pipeline.
 */

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');
const {
  absoluteStatePathToRelative,
  buildNodeOptions,
  matchesAnyPattern,
  normalizeStatePattern,
  pushReadonlySystemMounts,
  resolveRequestedStatePath,
  validateCapabilities,
} = require('./sandbox');

function log(msg) {
  console.log(`[tools] ${msg}`);
}

// ── Tool validation ─────────────────────────────────────────────────────────

/**
 * Validate that a tool module exports the required interface.
 * @param {Object} mod - require()'d module
 * @param {string} filePath - for error messages
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateTool(mod, filePath) {
  const errors = [];

  if (typeof mod.name !== 'string' || !mod.name.trim()) {
    errors.push(`${filePath}: missing or empty 'name' export`);
  }
  if (typeof mod.description !== 'string' || !mod.description.trim()) {
    errors.push(`${filePath}: missing or empty 'description' export`);
  }
  if (typeof mod.execute !== 'function') {
    errors.push(`${filePath}: missing 'execute' function export`);
  }
  if (mod.name && !/^[a-z][a-z0-9_]*$/.test(mod.name)) {
    errors.push(`${filePath}: name must be snake_case (got "${mod.name}")`);
  }
  const capabilityCheck = validateCapabilities(mod.capabilities);
  if (!capabilityCheck.valid) {
    for (const err of capabilityCheck.errors) {
      errors.push(`${filePath}: ${err}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Tool discovery ──────────────────────────────────────────────────────────

function scanToolsDirect() {
  const toolsDir = config.TOOLS_DIR;
  if (!fs.existsSync(toolsDir)) return [];

  const files = fs.readdirSync(toolsDir)
    .filter(f => f.endsWith('.js'))
    .sort();

  const MAX_LINES = 500;
  const registry = [];
  const seenNames = new Set();

  for (const file of files) {
    const fullPath = path.join(toolsDir, file);

    // Skip oversized files
    try {
      const lines = fs.readFileSync(fullPath, 'utf-8').split('\n').length;
      if (lines > MAX_LINES) {
        log(`skipping ${file}: ${lines} lines (max ${MAX_LINES})`);
        continue;
      }
    } catch { continue; }

    // Clear require cache for hot-reload after META merges
    try { delete require.cache[require.resolve(fullPath)]; } catch {}

    let mod;
    try {
      mod = require(fullPath);
    } catch (e) {
      log(`skipping ${file}: require failed — ${e.message}`);
      continue;
    }

    const { valid, errors } = validateTool(mod, file);
    if (!valid) {
      for (const err of errors) log(err);
      continue;
    }

    // Dedup: first file wins (alphabetical order)
    if (seenNames.has(mod.name)) {
      log(`skipping ${file}: duplicate name "${mod.name}"`);
      continue;
    }
    seenNames.add(mod.name);

    registry.push({
      name:        mod.name,
      description: mod.description,
      parameters:  mod.parameters || null,
      version:     mod.version || '0.1.0',
      tags:        mod.tags || [],
      capabilities: {
        read: (mod.capabilities.read || []).map(normalizeStatePattern).filter(Boolean),
        write: (mod.capabilities.write || []).map(normalizeStatePattern).filter(Boolean),
        call_tools: Array.isArray(mod.capabilities.call_tools) ? [...mod.capabilities.call_tools] : [],
      },
      _execute:    mod.execute,  // kept internal, not serialized
    });
  }

  return registry;
}

function scanToolsSandboxed() {
  let stdout = '';
  try {
    const bubblewrapArgs = [
      '--die-with-parent',
      '--new-session',
      '--unshare-all',
      '--clearenv',
      '--setenv', 'HOME', '/tmp',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'NODE_OPTIONS', buildNodeOptions(),
      '--setenv', 'TOOL_SANDBOX', '1',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--dir', '/workspace',
      '--dir', '/workspace/runner',
      '--dir', '/workspace/tools',
      '--ro-bind', config.RUNNER_DIR, '/workspace/runner',
      '--ro-bind', config.TOOLS_DIR, '/workspace/tools',
      '--chdir', '/workspace',
    ];
    pushReadonlySystemMounts(bubblewrapArgs);
    bubblewrapArgs.push(process.execPath, '/workspace/runner/tool_catalog.js');
    stdout = execFileSync('bwrap', bubblewrapArgs, {
      cwd: config.PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    log(`sandboxed tool catalog failed: ${e.message}`);
    return [];
  }

  let rows = [];
  try {
    rows = JSON.parse(stdout || '[]');
  } catch (e) {
    log(`tool catalog JSON parse failed: ${e.message}`);
    return [];
  }

  const registry = [];
  const seenNames = new Set();
  for (const row of rows) {
    if (row.error) {
      log(`skipping ${row.file}: ${row.error}`);
      continue;
    }
    const pseudoModule = {
      name: row.name,
      description: row.description,
      execute: row.hasExecute ? function noop() {} : undefined,
      capabilities: row.capabilities,
    };
    const { valid, errors } = validateTool(pseudoModule, row.file);
    if (!valid) {
      for (const err of errors) log(err);
      continue;
    }
    if (seenNames.has(row.name)) {
      log(`skipping ${row.file}: duplicate name "${row.name}"`);
      continue;
    }
    seenNames.add(row.name);
    registry.push({
      name: row.name,
      description: row.description,
      parameters: row.parameters || null,
      version: row.version || '0.1.0',
      tags: row.tags || [],
      capabilities: {
        read: (row.capabilities.read || []).map(normalizeStatePattern).filter(Boolean),
        write: (row.capabilities.write || []).map(normalizeStatePattern).filter(Boolean),
        call_tools: Array.isArray(row.capabilities.call_tools) ? [...row.capabilities.call_tools] : [],
        network: row.capabilities.network === true,
      },
      _execute: null,
    });
  }
  return registry;
}

/**
 * Scan tools/ directory, validate each, return registry.
 * Outside the sandbox, metadata discovery itself is sandboxed when bubblewrap
 * is available. Inside the sandbox, we load modules directly so execute()
 * remains callable.
 *
 * @returns {Object[]} Array of { name, description, parameters, version, tags, capabilities, _execute }
 */
function scanTools() {
  if (process.env.TOOL_SANDBOX === '1') {
    return scanToolsDirect();
  }
  if (fs.existsSync('/usr/bin/bwrap')) {
    return scanToolsSandboxed();
  }
  return scanToolsDirect();
}

// ── Tool manifest (for prompts) ─────────────────────────────────────────────

/**
 * Build a human-readable manifest string for injection into prompts.
 * @returns {string}
 */
function buildToolManifest() {
  const tools = scanTools();
  if (tools.length === 0) return '(no tools registered)';

  return tools.map(t => {
    const params = t.parameters
      ? Object.keys(t.parameters.properties || {}).join(', ')
      : 'none';
    const tags = t.tags.length > 0 ? ` [${t.tags.join(', ')}]` : '';
    const reads = t.capabilities.read.length > 0 ? t.capabilities.read.join(', ') : 'none';
    const writes = t.capabilities.write.length > 0 ? t.capabilities.write.join(', ') : 'none';
    return `- ${t.name} (v${t.version}): ${t.description} | params: ${params}${tags} | read: ${reads} | write: ${writes}`;
  }).join('\n');
}

/**
 * Load last tool result for context injection.
 * @returns {string}
 */
function loadLastToolResult() {
  try {
    const r = JSON.parse(fs.readFileSync(config.TOOL_RESULT_PATH, 'utf-8'));
    if (r.workflow) {
      const steps = (r.steps || []).map(s =>
        `  ${s.tool}: ${s.status}${s.status === 'error' ? ' — ' + s.error : ''} (${s.duration_ms}ms)`
      ).join('\n');
      return `Workflow (${r.status}, ${r.total_duration_ms}ms):\n${steps}`;
    }
    if (r.status === 'error') {
      return `Tool "${r.tool}" failed: ${r.error}`;
    }
    const resultStr = typeof r.result === 'string'
      ? r.result.slice(0, 500)
      : JSON.stringify(r.result).slice(0, 500);
    return `Tool "${r.tool}" (${r.status}, ${r.duration_ms}ms): ${resultStr}`;
  } catch {
    return '';
  }
}

// ── Tool execution ──────────────────────────────────────────────────────────

const MAX_RECURSION = 3;
const MAX_WORKFLOW_STEPS = 5;

function resolveExecutionPlan(toolName, registry, seen = new Set()) {
  const tool = registry.find(t => t.name === toolName);
  if (!tool) {
    throw new Error(`Tool "${toolName}" not found`);
  }
  if (seen.has(toolName)) {
    throw new Error(`Recursive call_tools cycle detected at "${toolName}"`);
  }

  const nextSeen = new Set(seen);
  nextSeen.add(toolName);

  const read = new Set(tool.capabilities.read || []);
  const write = new Set(tool.capabilities.write || []);
  const allowedTools = new Set([toolName]);

  for (const nested of (tool.capabilities.call_tools || [])) {
    const nestedPlan = resolveExecutionPlan(nested, registry, nextSeen);
    for (const pattern of nestedPlan.readPatterns) read.add(pattern);
    for (const pattern of nestedPlan.writePatterns) write.add(pattern);
    for (const allowed of nestedPlan.allowedTools) allowedTools.add(allowed);
  }

  return {
    tool,
    readPatterns: Array.from(read),
    writePatterns: Array.from(write),
    allowedTools: Array.from(allowedTools),
  };
}

/**
 * Execute a single tool by name.
 *
 * @param {string} toolName
 * @param {Object} args
 * @param {Object[]} registry - from scanTools()
 * @param {number} depth - recursion depth for callTool chains
 * @returns {{ status, result, error, duration_ms }}
 */
function executeSingle(toolName, args, registry, depth = 0, callerName = null) {
  const tool = registry.find(t => t.name === toolName);
  if (!tool) {
    return { tool: toolName, status: 'error', error: `Tool "${toolName}" not found`, duration_ms: 0 };
  }

  if (depth > MAX_RECURSION) {
    return { tool: toolName, status: 'error', error: `Max recursion depth (${MAX_RECURSION}) exceeded`, duration_ms: 0 };
  }
  if (callerName && !(registry.find(t => t.name === callerName)?.capabilities.call_tools || []).includes(toolName)) {
    return { tool: toolName, status: 'error', error: `Tool "${callerName}" is not allowed to call "${toolName}"`, duration_ms: 0 };
  }

  const context = {
    config,
    cycle: parseInt(process.env.CYCLE || '0', 10),
    today: new Date().toISOString().slice(0, 10),
    readState(filePath) {
      try {
        const absPath = resolveRequestedStatePath(filePath, config.STATE_DIR);
        const relPath = absoluteStatePathToRelative(absPath);
        if (!relPath || (!matchesAnyPattern(relPath, tool.capabilities.read) && !matchesAnyPattern(relPath, tool.capabilities.write))) {
          throw new Error(`Read not permitted: ${filePath}`);
        }
        return fs.readFileSync(absPath, 'utf-8');
      } catch (e) {
        throw new Error(`readState failed: ${e.message}`);
      }
    },
    writeState(filePath, content) {
      try {
        const absPath = resolveRequestedStatePath(filePath, config.STATE_DIR);
        const relPath = absoluteStatePathToRelative(absPath);
        if (!relPath || !matchesAnyPattern(relPath, tool.capabilities.write)) {
          throw new Error(`Write not permitted: ${filePath}`);
        }
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content);
        return `state/${relPath}`;
      } catch (e) {
        throw new Error(`writeState failed: ${e.message}`);
      }
    },
    callTool(name, callArgs) {
      if (!(tool.capabilities.call_tools || []).includes(name)) {
        throw new Error(`callTool(${name}) not permitted for "${toolName}"`);
      }
      const r = executeSingle(name, callArgs, registry, depth + 1, toolName);
      if (r.status === 'error') throw new Error(`callTool(${name}): ${r.error}`);
      return r.result;
    },
  };

  const start = Date.now();
  try {
    // Tools should be synchronous for orchestrator compatibility.
    // If execute returns a Promise, we can't await it in sync context,
    // so we run it via a subprocess pattern with a timeout.
    const result = tool._execute(args, context);

    // Handle sync result
    if (result && typeof result.then === 'function') {
      // Async tool — not supported in sync orchestrator.
      // Log warning and return what we can.
      return {
        tool: toolName,
        status: 'error',
        error: 'Tool returned a Promise — tools must be synchronous',
        duration_ms: Date.now() - start,
      };
    }

    return {
      tool: toolName,
      status: 'success',
      result,
      duration_ms: Date.now() - start,
    };
  } catch (e) {
    return {
      tool: toolName,
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - start,
    };
  }
}

function executeSingleWithTimeout(toolName, args) {
  const encodedArgs = Buffer.from(JSON.stringify(args || {}), 'utf-8').toString('base64');
  const start = Date.now();
  let registry;

  try {
    registry = scanTools();
    resolveExecutionPlan(toolName, registry);
  } catch (e) {
    return {
      tool: toolName,
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - start,
    };
  }

  // Network-capable tools bypass bubblewrap (which unshares-all namespaces, blocking network).
  const _tool = registry.find(t => t.name === toolName);
  const runnerPath = path.join(config.RUNNER_DIR, _tool?.capabilities?.network ? 'network_run.js' : 'sandbox_run.js');

  try {
    const stdout = execFileSync(process.execPath, [runnerPath, toolName, encodedArgs], {
      cwd: config.PROJECT_ROOT,
      encoding: 'utf-8',
      timeout: config.TOOL_TIMEOUT_MS + 5000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    if (!stdout) {
      return {
        tool: toolName,
        status: 'error',
        error: 'Tool runner returned no output',
        duration_ms: Date.now() - start,
      };
    }

    const parsed = JSON.parse(stdout);
    if (!parsed.duration_ms) {
      parsed.duration_ms = Date.now() - start;
    }
    if (!parsed.tool) {
      parsed.tool = toolName;
    }
    return parsed;
  } catch (e) {
    const timedOut = e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT';
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    return {
      tool: toolName,
      status: 'error',
      error: timedOut
        ? `Tool timed out after ${config.TOOL_TIMEOUT_MS}ms`
        : `Tool runner failed: ${stderr.slice(0, 200)}`,
      duration_ms: Date.now() - start,
    };
  }
}

/**
 * Process a tool request file: single tool or workflow.
 * Reads tool_request.json, executes, writes tool_result.json, deletes request.
 *
 * @returns {Object} result written to tool_result.json
 */
function executeToolRequest() {
  let result;
  let request;
  try {
    request = JSON.parse(fs.readFileSync(config.TOOL_REQUEST_PATH, 'utf-8'));
  } catch (e) {
    result = {
      tool: '__request__',
      status: 'error',
      error: `Invalid tool request JSON: ${e.message}`,
      executed_at: new Date().toISOString(),
      duration_ms: 0,
    };
    try {
      fs.writeFileSync(config.TOOL_RESULT_PATH, JSON.stringify(result, null, 2));
    } catch (writeErr) {
      log(`could not write tool_result.json: ${writeErr.message}`);
    }
    try {
      fs.unlinkSync(config.TOOL_REQUEST_PATH);
    } catch {}
    log(`could not read tool_request.json: ${e.message}`);
    return result;
  }

  if (request.workflow && Array.isArray(request.workflow)) {
    // ── Workflow execution ─────────────────────────────────────────────
    const steps = request.workflow;
    if (steps.length > MAX_WORKFLOW_STEPS) {
      result = {
        workflow: true,
        status: 'error',
        error: `Too many steps: ${steps.length} (max ${MAX_WORKFLOW_STEPS})`,
        steps: [],
        executed_at: new Date().toISOString(),
        total_duration_ms: 0,
      };
    } else {
      const workflowStart = Date.now();
      const stepResults = [];
      let prevResult = null;

      for (const step of steps) {
        // $prev merges previous result into args
        let args = { ...(step.args || {}) };
        if (args.$prev && prevResult !== null) {
          delete args.$prev;
          if (typeof prevResult === 'object' && !Array.isArray(prevResult)) {
            args = { ...prevResult, ...args };
          } else {
            args._prev = prevResult;
          }
        } else {
          delete args.$prev;
        }

        const stepResult = executeSingleWithTimeout(step.tool, args);
        stepResults.push(stepResult);

        if (stepResult.status === 'error') {
          // Halt on failure
          result = {
            workflow: true,
            status: 'error',
            error: `Step "${step.tool}" failed: ${stepResult.error}`,
            steps: stepResults,
            executed_at: new Date().toISOString(),
            total_duration_ms: Date.now() - workflowStart,
          };
          break;
        }

        prevResult = stepResult.result;

        // Workflow timeout
        if (Date.now() - workflowStart > config.WORKFLOW_TIMEOUT_MS) {
          result = {
            workflow: true,
            status: 'error',
            error: `Workflow timeout (${config.WORKFLOW_TIMEOUT_MS}ms)`,
            steps: stepResults,
            executed_at: new Date().toISOString(),
            total_duration_ms: Date.now() - workflowStart,
          };
          break;
        }
      }

      if (!result) {
        result = {
          workflow: true,
          status: 'success',
          steps: stepResults,
          executed_at: new Date().toISOString(),
          total_duration_ms: Date.now() - workflowStart,
        };
      }
    }

  } else if (request.tool) {
    // ── Single tool execution ─────────────────────────────────────────
    result = executeSingleWithTimeout(request.tool, request.args || {});
    result.executed_at = new Date().toISOString();

  } else {
    result = {
      tool: '__request__',
      status: 'error',
      error: 'Invalid request: must have "tool" or "workflow" field',
      executed_at: new Date().toISOString(),
      duration_ms: 0,
    };
  }

  // Write result
  try {
    fs.writeFileSync(config.TOOL_RESULT_PATH, JSON.stringify(result, null, 2));
  } catch (e) {
    log(`could not write tool_result.json: ${e.message}`);
  }

  // Consume request
  try {
    fs.unlinkSync(config.TOOL_REQUEST_PATH);
  } catch {}

  return result;
}

module.exports = {
  scanTools,
  scanToolsDirect,
  validateTool,
  buildToolManifest,
  loadLastToolResult,
  executeToolRequest,
  executeSingle,
  resolveExecutionPlan,
};
