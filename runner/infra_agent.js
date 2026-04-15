#!/usr/bin/env node
/**
 * runner/infra_agent.js — Operator-approved infrastructure provisioner (§21)
 *
 * INVOCATION: spawned exclusively by telegram_bot.js after explicit operator
 * approval via Telegram inline keyboard. Sebastian cannot invoke this directly.
 *
 * Flow:
 *   1. Read state/infra_request.json (must have status == "approved")
 *   2. Update status → "building", notify TG
 *   3. Dispatch to type handler (static_site | cloud_run | bucket | pubsub)
 *   4. Execute provisioning commands (gcloud)
 *   5. Update status → "done" | "failed", notify TG with result
 *   6. Append to state/infra_request_log.jsonl
 *
 * Supported types:
 *   static_site  — GCS bucket + CORS + uniform access + CDN-ready config
 *   cloud_run    — Deploy a container image to Cloud Run
 *   bucket       — Create a GCS bucket with optional IAM binding
 *   pubsub       — Create a Pub/Sub topic (+optional subscription)
 *
 * Credentials: uses the same GOOGLE_APPLICATION_CREDENTIALS service account
 * as the rest of the runner (sebastian-hunter-vertex.json).
 * Project: read from GCLOUD_PROJECT env var (or from service account JSON).
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const crypto  = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Load .env if not already loaded
if (fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf-8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const config = require('./lib/config');

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID   || '';
const GCP_REGION = process.env.GCLOUD_REGION || 'us-central1';

// Dedicated infra-provisioner SA (infra-provisioner@sebastian-hunter.iam.gserviceaccount.com)
// Roles: aiplatform.user, storage.admin, run.admin, pubsub.editor
// Keeps Sebastian's and builder's SA quotas clean and scoped to their own work.
const SA_KEY_PATH = process.env.INFRA_SA_KEY_PATH ||
  path.join(ROOT, 'sebastian-infra-vertex.json');

const GCP_PROJECT = (() => {
  try {
    return JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf-8')).project_id || '';
  } catch { return process.env.GCLOUD_PROJECT || ''; }
})();

// Short-lived bearer token cache
let _tokenCache = null; // { token, expiry }

/**
 * Derive a short-lived OAuth2 bearer token from the builder service account key.
 * Uses the same JWT approach as runner/gcp_auth.js.
 * Returns the token string, throws on failure.
 */
async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_tokenCache && _tokenCache.expiry > now + 60) return _tokenCache.token;

  const sa = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf-8'));

  function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const header  = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss:   sa.client_email,
    sub:   sa.client_email,
    aud:   'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    iat:   now,
    exp:   now + 3600,
  })));
  const unsigned = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(unsigned);
  const sig = base64url(sign.sign(sa.private_key));
  const jwt = `${unsigned}.${sig}`;

  const token = await new Promise((resolve, reject) => {
    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      port: 443,
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(`Token error: ${data.slice(0, 200)}`));
        } catch { reject(new Error('Token parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Token request timeout')); });
    req.write(body);
    req.end();
  });

  _tokenCache = { token, expiry: now + 3600 };
  return token;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[infra_agent ${ts}] ${msg}`);
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function appendLog(entry) {
  try {
    fs.appendFileSync(
      config.INFRA_REQUEST_LOG_PATH,
      JSON.stringify(entry) + '\n',
      'utf-8',
    );
  } catch {}
}

function telegramSend(text) {
  if (!BOT_TOKEN || !CHAT_ID) return Promise.resolve();
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: text.length > 4000 ? text.slice(0, 4000) + '\n[truncated]' : text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a short build progress update to Telegram.
 * Non-blocking — failures are swallowed so they never abort provisioning.
 */
async function progress(emoji, text) {
  log(`progress: ${emoji} ${text}`);
  await telegramSend(`${emoji} <i>${escapeHtml(text)}</i>`).catch(() => {});
}

// ── Gemini planning ───────────────────────────────────────────────────────────

const GCP_LOCATION = process.env.GCLOUD_REGION || 'us-central1';
const INFRA_MODEL  = process.env.INFRA_MODEL || 'gemini-2.5-pro-preview-05-06';

/**
 * callGemini(prompt, token) — call Vertex AI using the infra-provisioner SA token.
 * Returns response text, throws on failure.
 */
async function callGemini(prompt, token) {
  const apiPath = `/v1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/publishers/google/models/${INFRA_MODEL}:generateContent`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 16384 },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${GCP_LOCATION}-aiplatform.googleapis.com`,
      port: 443,
      path: apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${token}`,
      },
      timeout: 120_000,
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const text = j?.candidates?.[0]?.content?.parts
            ?.filter(p => p.text)
            ?.map(p => p.text)
            ?.join('')
            ?.trim();
          if (!text) throw new Error(`No content from Gemini: ${raw.slice(0, 300)}`);
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Gemini request timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * planInfra(req, token) — ask Gemini to determine the right GCP resource type,
 * generate a spec, and (for static sites) produce the actual website files.
 *
 * Returns { type, spec, rationale, files? }
 * Throws on failure.
 */
async function planInfra(req, token) {
  const prompt = `You are an infrastructure planning agent for a GCP-hosted AI system called Sebastian Hunter.

The operator has approved the following infrastructure request:
Title: ${req.title}
Reason: ${req.reason || '(none given)'}
Intent: ${req.intent || req.title}

Determine what single GCP resource to provision and return a JSON plan.

Supported types:
- static_site  — GCS bucket with public static website hosting (HTML/CSS/JS)
- cloud_run    — container deployed to Cloud Run (for services/APIs with a Docker image)
- bucket       — general-purpose GCS storage bucket (no web hosting)
- pubsub       — Pub/Sub topic + optional subscription

Rules:
- Choose the simplest resource that satisfies the intent.
- For "website", "publish", "articles", "portfolio", "blog" → use static_site.
- For "API", "service", "backend", "server" with a container image → use cloud_run.
- For "store", "upload", "data", "files" without web hosting → use bucket.
- For "events", "queue", "stream", "notifications" → use pubsub.

Return ONLY a single valid JSON object (no markdown fences, no explanation) matching this schema:
{
  "type": "static_site|cloud_run|bucket|pubsub",
  "spec": {
    "bucket_name": "sebastian-hunter-<slug>",   // static_site or bucket: globally unique, lowercase, 3-63 chars
    "region": "us-central1",                    // all types: optional, default us-central1
    "service_name": "<slug>",                   // cloud_run only
    "image": "<gcr.io/...>",                    // cloud_run only — use placeholder if unknown
    "port": 8080,                               // cloud_run only
    "allow_unauthenticated": true,              // cloud_run only
    "public": true,                             // bucket only
    "topic_name": "<slug>",                     // pubsub only
    "subscription": "<slug>"                    // pubsub only, optional
  },
  "rationale": "One sentence explaining this choice.",
  "files": {
    "index.html": "<!DOCTYPE html>...",
    "style.css": "...",
    "404.html": "<!DOCTYPE html>..."
  }
}

Notes:
- "spec" must include only the fields relevant to the chosen type.
- "files" is required ONLY for static_site. Generate a real, minimal, well-designed site
  matching the intent (use clean HTML5 + inline or linked CSS). Include at minimum
  index.html and 404.html. Keep each file under 60 KB.
- Bucket names must start with a lowercase letter and contain only lowercase letters,
  digits, and hyphens. Use "sebastian-hunter-" as prefix for uniqueness.
- Do NOT wrap the response in markdown code fences.`;

  const raw = await callGemini(prompt, token);

  // Strip any accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON plan: ${cleaned.slice(0, 400)}`);
  }

  if (!plan.type) throw new Error('Gemini plan missing required "type" field');
  if (!plan.spec) throw new Error('Gemini plan missing required "spec" field');
  return plan;
}

/**
 * Run a gcloud command safely using the service account bearer token.
 * args: array of strings (never shell-interpolated).
 * Returns { ok, stdout, stderr }.
 */
function gcloud(args, timeoutMs = 120_000, accessToken = '') {
  try {
    // Validate: no shell metacharacters in any arg
    for (const a of args) {
      if (typeof a !== 'string' || /[;&|`$(){}\\<>"\n\r\0]/.test(a)) {
        throw new Error(`Unsafe argument rejected: ${JSON.stringify(a)}`);
      }
    }
    const env = { ...process.env };
    if (accessToken) env.CLOUDSDK_AUTH_ACCESS_TOKEN = accessToken;
    const stdout = execFileSync('gcloud', args, {
      encoding: 'utf-8',
      timeout: timeoutMs,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout ? e.stdout.toString().trim() : '',
      stderr: e.stderr ? e.stderr.toString().trim() : (e.message || ''),
    };
  }
}

// ── Generated file upload ─────────────────────────────────────────────────────

/**
 * uploadGeneratedFiles(bucketName, files, token)
 *
 * Write generated file map { filename: content } to a temp staging directory
 * then upload each file to the GCS bucket via `gcloud storage cp`.
 *
 * Returns { ok, uploaded, errors }
 */
async function uploadGeneratedFiles(bucketName, files, token) {
  const sandboxId = sanitizeBucketName(bucketName) || `tmp_${Date.now()}`;
  const sandboxDir = path.join(ROOT, 'state', 'sandboxes', `infra_${sandboxId}`);
  fs.mkdirSync(sandboxDir, { recursive: true });

  const uploaded = [];
  const errors = [];

  for (const [filename, content] of Object.entries(files)) {
    // Sanitize filename: only allow safe path components (no ../, no absolute paths)
    const safeName = path.basename(filename).replace(/[^a-zA-Z0-9.\-_]/g, '_');
    if (!safeName || safeName === '.' || safeName === '..') {
      errors.push(`Skipped unsafe filename: ${filename}`);
      continue;
    }
    const localPath = path.join(sandboxDir, safeName);
    fs.writeFileSync(localPath, String(content), 'utf-8');

    await progress('⚙️', `Uploading ${safeName}...`);
    const cp = gcloud([
      'storage', 'cp',
      localPath,
      `gs://${bucketName}/${safeName}`,
      `--project=${GCP_PROJECT}`,
    ], 60_000, token);

    if (cp.ok) {
      uploaded.push(safeName);
      await progress('✅', `Uploaded ${safeName}`);
    } else {
      errors.push(`${safeName}: ${cp.stderr.slice(0, 200)}`);
      await progress('⚠️', `Upload warning: ${safeName} — ${cp.stderr.slice(0, 120)}`);
    }
  }

  // Clean up staging dir
  try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}

  return { ok: errors.length === 0, uploaded, errors };
}

// ── Type handlers ─────────────────────────────────────────────────────────────

/**
 * static_site: provision a public-read GCS bucket for static hosting.
 *
 * spec fields:
 *   bucket_name  (required) — globally unique GCS bucket name
 *   region       (optional) — defaults to GCP_REGION
 *   description  (optional) — human note, not sent to GCP
 */
async function provisionStaticSite(req, token = '') {
  const spec = req.spec || {};
  const bucket = sanitizeBucketName(spec.bucket_name);
  if (!bucket) return { ok: false, error: 'spec.bucket_name is required and must be a safe name' };

  const region = sanitizeId(spec.region || GCP_REGION);
  const steps = [];

  // 1. Create bucket
  await progress('⚙️', `Creating bucket gs://${bucket} in ${region}...`);
  const create = gcloud([
    'storage', 'buckets', 'create',
    `gs://${bucket}`,
    `--location=${region}`,
    `--project=${GCP_PROJECT}`,
    '--uniform-bucket-level-access',
  ], 120_000, token);
  steps.push({ step: 'create_bucket', ...create });
  if (!create.ok && !create.stderr.includes('already exists')) {
    await progress('❌', `Bucket creation failed: ${create.stderr.slice(0, 200)}`);
    return { ok: false, error: create.stderr, steps };
  }
  await progress('✅', `Bucket gs://${bucket} ready`);

  // 2. Make publicly readable
  await progress('⚙️', 'Setting public read access...');
  const iam = gcloud([
    'storage', 'buckets', 'add-iam-policy-binding',
    `gs://${bucket}`,
    '--member=allUsers',
    '--role=roles/storage.objectViewer',
    `--project=${GCP_PROJECT}`,
  ], 120_000, token);
  steps.push({ step: 'set_public_iam', ...iam });
  if (iam.ok) await progress('✅', 'Public access configured');
  else await progress('⚠️', `IAM warning: ${iam.stderr.slice(0, 200)}`);

  // 3. Set website configuration (index + 404)
  await progress('⚙️', 'Configuring static website hosting...');
  const web = gcloud([
    'storage', 'buckets', 'update',
    `gs://${bucket}`,
    '--web-main-page-suffix=index.html',
    '--web-error-page=404.html',
    `--project=${GCP_PROJECT}`,
  ], 120_000, token);
  steps.push({ step: 'set_website_config', ...web });
  if (web.ok) await progress('✅', 'Website config set (index.html / 404.html)');
  else await progress('⚠️', `Website config warning: ${web.stderr.slice(0, 200)}`);

  const url = `https://storage.googleapis.com/${bucket}/index.html`;
  return {
    ok: true,
    summary: `Static site bucket provisioned: gs://${bucket}`,
    url,
    steps,
  };
}

/**
 * cloud_run: deploy a container image to Cloud Run.
 *
 * spec fields:
 *   service_name  (required) — Cloud Run service name
 *   image         (required) — container image (e.g. gcr.io/project/image:tag)
 *   region        (optional) — defaults to GCP_REGION
 *   port          (optional) — container port, default 8080
 *   allow_unauthenticated (optional) — boolean, default true
 */
async function provisionCloudRun(req, token = '') {
  const spec = req.spec || {};
  const service = sanitizeId(spec.service_name);
  const image   = spec.image;
  if (!service) return { ok: false, error: 'spec.service_name is required' };
  if (!image || !/^[\w.\-/:@]+$/.test(image)) return { ok: false, error: 'spec.image is required and must be a valid image reference' };

  const region = sanitizeId(spec.region || GCP_REGION);
  const port   = parseInt(spec.port || '8080', 10);
  if (isNaN(port) || port < 1 || port > 65535) return { ok: false, error: 'spec.port must be a valid port number' };

  const steps = [];
  const deployArgs = [
    'run', 'deploy', service,
    `--image=${image}`,
    `--region=${region}`,
    `--port=${port}`,
    `--project=${GCP_PROJECT}`,
    '--format=json',
  ];
  if (spec.allow_unauthenticated !== false) {
    deployArgs.push('--allow-unauthenticated');
  }

  await progress('⚙️', `Deploying Cloud Run service '${service}' from ${image} — this may take 1–3 min...`);
  const deploy = gcloud(deployArgs, 300_000, token);
  steps.push({ step: 'deploy_cloud_run', ...deploy });
  if (!deploy.ok) {
    await progress('❌', `Deploy failed: ${deploy.stderr.slice(0, 200)}`);
    return { ok: false, error: deploy.stderr, steps };
  }

  // Extract service URL from JSON output
  let serviceUrl = '';
  try { serviceUrl = JSON.parse(deploy.stdout)?.status?.url || ''; } catch {}

  await progress('✅', `Service deployed${serviceUrl ? ': ' + serviceUrl : ''}`);
  return {
    ok: true,
    summary: `Cloud Run service '${service}' deployed`,
    url: serviceUrl,
    steps,
  };
}

/**
 * bucket: create a GCS bucket (general-purpose, not static site).
 *
 * spec fields:
 *   bucket_name  (required)
 *   region       (optional)
 *   public       (optional) boolean — set allUsers objectViewer
 */
async function provisionBucket(req, token = '') {
  const spec = req.spec || {};
  const bucket = sanitizeBucketName(spec.bucket_name);
  if (!bucket) return { ok: false, error: 'spec.bucket_name is required' };

  const region = sanitizeId(spec.region || GCP_REGION);
  const steps = [];

  await progress('⚙️', `Creating bucket gs://${bucket} in ${region}...`);
  const create = gcloud([
    'storage', 'buckets', 'create',
    `gs://${bucket}`,
    `--location=${region}`,
    `--project=${GCP_PROJECT}`,
    '--uniform-bucket-level-access',
  ], 120_000, token);
  steps.push({ step: 'create_bucket', ...create });
  if (!create.ok && !create.stderr.includes('already exists')) {
    await progress('❌', `Bucket creation failed: ${create.stderr.slice(0, 200)}`);
    return { ok: false, error: create.stderr, steps };
  }
  await progress('✅', `Bucket gs://${bucket} created`);

  if (spec.public === true) {
    await progress('⚙️', 'Setting public read access...');
    const iam = gcloud([
      'storage', 'buckets', 'add-iam-policy-binding',
      `gs://${bucket}`,
      '--member=allUsers',
      '--role=roles/storage.objectViewer',
      `--project=${GCP_PROJECT}`,
    ], 120_000, token);
    steps.push({ step: 'set_public_iam', ...iam });
    if (iam.ok) await progress('✅', 'Public access configured');
    else await progress('⚠️', `IAM warning: ${iam.stderr.slice(0, 200)}`);
  }

  return { ok: true, summary: `Bucket gs://${bucket} created`, steps };
}

/**
 * pubsub: create a Pub/Sub topic and optional subscription.
 *
 * spec fields:
 *   topic_name    (required)
 *   subscription  (optional) — subscription name to create
 */
async function provisionPubSub(req, token = '') {
  const spec = req.spec || {};
  const topic = sanitizeId(spec.topic_name);
  if (!topic) return { ok: false, error: 'spec.topic_name is required' };

  const steps = [];

  await progress('⚙️', `Creating Pub/Sub topic '${topic}'...`);
  const create = gcloud([
    'pubsub', 'topics', 'create', topic,
    `--project=${GCP_PROJECT}`,
  ], 120_000, token);
  steps.push({ step: 'create_topic', ...create });
  if (!create.ok && !create.stderr.includes('already exists')) {
    await progress('❌', `Topic creation failed: ${create.stderr.slice(0, 200)}`);
    return { ok: false, error: create.stderr, steps };
  }
  await progress('✅', `Topic '${topic}' created`);

  if (spec.subscription) {
    const sub = sanitizeId(spec.subscription);
    await progress('⚙️', `Creating subscription '${sub}'...`);
    const createSub = gcloud([
      'pubsub', 'subscriptions', 'create', sub,
      `--topic=${topic}`,
      `--project=${GCP_PROJECT}`,
    ], 120_000, token);
    steps.push({ step: 'create_subscription', ...createSub });
    if (createSub.ok) await progress('✅', `Subscription '${sub}' created`);
    else await progress('⚠️', `Subscription warning: ${createSub.stderr.slice(0, 200)}`);
  }

  return { ok: true, summary: `Pub/Sub topic '${topic}' created`, steps };
}

// ── Input sanitization ──────────────────────────────────────────────────────

/** Allow only lowercase letters, digits, hyphens, underscores, dots (for bucket names). */
function sanitizeBucketName(name) {
  if (typeof name !== 'string') return '';
  const clean = name.toLowerCase().replace(/[^a-z0-9\-_.]/g, '');
  if (clean.length < 3 || clean.length > 63) return '';
  if (!/^[a-z0-9]/.test(clean)) return '';
  return clean;
}

/** Allow only alphanumeric, hyphens, underscores (for service/topic/region IDs). */
function sanitizeId(s) {
  if (typeof s !== 'string') return '';
  const clean = s.replace(/[^a-zA-Z0-9\-_]/g, '');
  if (!clean || clean.length > 63) return '';
  return clean;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('Infra agent starting');

  const req = loadJson(config.INFRA_REQUEST_PATH);
  if (!req) {
    log('ERROR: no infra_request.json found — exiting');
    process.exit(1);
  }
  if (req.status !== 'approved') {
    log(`ERROR: request status is '${req.status}', not 'approved' — exiting`);
    process.exit(1);
  }
  if (!GCP_PROJECT) {
    log('ERROR: GCP_PROJECT not set — exiting');
    await telegramSend('❌ <b>Infra agent failed</b>\n\nGCP_PROJECT not configured.');
    process.exit(1);
  }

  log(`Processing: [${req.id}] ${req.title}`);

  // Acquire a bearer token from infra-provisioner service account.
  // This is passed to every gcloud and Gemini call, ensuring we always
  // use the right identity regardless of VM gcloud config.
  let token = '';
  try {
    token = await getAccessToken();
    log(`Access token acquired for ${JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf-8')).client_email}`);
  } catch (e) {
    log(`WARNING: could not acquire access token — falling back to VM default credentials: ${e.message}`);
  }

  // ── Planning phase ──────────────────────────────────────────────────────────
  // If the request has no 'type' set, Sebastian wrote a high-level intent.
  // Ask Gemini to determine the right GCP architecture + generate files.
  let generatedFiles = null;
  if (!req.type) {
    await progress('🧠', 'Planning infrastructure from your intent...');
    try {
      const plan = await planInfra(req, token);
      req.type = plan.type;
      req.spec = plan.spec;
      if (plan.files && Object.keys(plan.files).length > 0) {
        generatedFiles = plan.files;
      }
      req.plan_rationale = plan.rationale;
      log(`Plan: type=${plan.type} rationale=${plan.rationale}`);
      await progress('📋', `Plan: ${plan.type} — ${plan.rationale}`);
      // Persist the resolved type + spec so the log is auditable
      writeJson(config.INFRA_REQUEST_PATH, req);
    } catch (e) {
      log(`Planning failed: ${e.message}`);
      await telegramSend(
        `❌ <b>Infra planning failed</b>\n\n<b>${escapeHtml(req.title)}</b>\n\n<code>${escapeHtml(e.message.slice(0, 600))}</code>`,
      );
      req.status = 'failed';
      req.resolution_note = `Planning phase failed: ${e.message}`;
      req.resolved_at = new Date().toISOString();
      writeJson(config.INFRA_REQUEST_PATH, req);
      appendLog({ ts: req.resolved_at, id: req.id, type: 'unknown', title: req.title, status: 'failed', resolution: req.resolution_note });
      process.exit(1);
    }
  }

  log(`Provisioning: [${req.id}] ${req.title} (type: ${req.type})`);

  // Mark as building
  req.status = 'building';
  req.build_started_at = new Date().toISOString();
  writeJson(config.INFRA_REQUEST_PATH, req);
  await telegramSend(
    `🔧 <b>Infra agent started</b>\n\n` +
    `<b>${escapeHtml(req.title)}</b>\nType: <code>${req.type}</code>\n` +
    `ID: <code>${req.id}</code>`,
  );

  let result;
  try {
    switch (req.type) {
      case 'static_site': result = await provisionStaticSite(req, token); break;
      case 'cloud_run':   result = await provisionCloudRun(req, token);   break;
      case 'bucket':      result = await provisionBucket(req, token);     break;
      case 'pubsub':      result = await provisionPubSub(req, token);     break;
      default:
        result = { ok: false, error: `Unsupported infra type: '${req.type}'. Supported: static_site, cloud_run, bucket, pubsub` };
    }
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  // If Gemini generated website files and we just provisioned a static_site,
  // upload them to the bucket now.
  if (result.ok && generatedFiles && req.type === 'static_site' && req.spec?.bucket_name) {
    await progress('🗂️', `Uploading ${Object.keys(generatedFiles).length} generated file(s) to gs://${req.spec.bucket_name}...`);
    const upload = await uploadGeneratedFiles(req.spec.bucket_name, generatedFiles, token);
    if (upload.uploaded.length > 0) {
      result.summary += ` | Uploaded: ${upload.uploaded.join(', ')}`;
    }
    if (upload.errors.length > 0) {
      log(`Upload warnings: ${upload.errors.join('; ')}`);
    }
  }

  const now = new Date().toISOString();
  req.status = result.ok ? 'done' : 'failed';
  req.resolved_at = now;
  req.resolution_note = result.ok ? (result.summary || 'Provisioned successfully') : result.error;
  req.build_log = result.steps ? JSON.stringify(result.steps, null, 2) : null;
  if (result.url) req.provisioned_url = result.url;
  writeJson(config.INFRA_REQUEST_PATH, req);

  // Append to log
  appendLog({
    ts: now,
    id: req.id,
    type: req.type,
    title: req.title,
    status: req.status,
    resolution: req.resolution_note,
    url: req.provisioned_url || null,
  });

  // Notify operator
  if (result.ok) {
    let msg = `✅ <b>Infra provisioned</b>\n\n<b>${escapeHtml(req.title)}</b>\n\n${escapeHtml(result.summary)}`;
    if (result.url) msg += `\n\n🔗 <a href="${escapeHtml(result.url)}">${escapeHtml(result.url)}</a>`;
    await telegramSend(msg);
    log(`Done: ${result.summary}`);
  } else {
    await telegramSend(
      `❌ <b>Infra provisioning failed</b>\n\n<b>${escapeHtml(req.title)}</b>\n\n<code>${escapeHtml((result.error || '').slice(0, 800))}</code>`,
    );
    log(`Failed: ${result.error}`);
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

main().catch(async (e) => {
  log(`FATAL: ${e.message}`);
  await telegramSend(`❌ <b>Infra agent fatal error</b>\n\n<code>${e.message?.slice(0, 500)}</code>`).catch(() => {});
  process.exit(1);
});
