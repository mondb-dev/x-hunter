#!/usr/bin/env node
'use strict';

const Module = require('module');

const BLOCKED_MODULES = new Set([
  'child_process',
  'cluster',
  'dgram',
  'dns',
  'http',
  'http2',
  'https',
  'inspector',
  'net',
  'repl',
  'tls',
  'vm',
  'worker_threads',
]);

const originalLoad = Module._load;
Module._load = function guardedModuleLoad(request, parent, isMain) {
  const normalized = typeof request === 'string' && request.startsWith('node:')
    ? request.slice('node:'.length)
    : request;
  if (BLOCKED_MODULES.has(normalized)) {
    throw new Error(`Module "${request}" is blocked in TOOL_SANDBOX`);
  }
  return originalLoad.apply(this, arguments);
};

const originalBinding = process.binding;
process.binding = function guardedBinding(name) {
  if (['cares_wrap', 'pipe_wrap', 'spawn_sync', 'tcp_wrap', 'tls_wrap', 'udp_wrap', 'worker'].includes(name)) {
    throw new Error(`process.binding("${name}") is blocked in TOOL_SANDBOX`);
  }
  return originalBinding.apply(this, arguments);
};
