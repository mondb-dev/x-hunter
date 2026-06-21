'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const credPath = process.env.VERTEX_CREDENTIALS_PATH ||
  path.join(os.homedir(), '.openclaw-x-hunter', 'secrets', 'sebastian-hunter-vertex.json');

if (!fs.existsSync(credPath)) {
  process.exit(0);
}

const env = {
  ...process.env,
  GOOGLE_APPLICATION_CREDENTIALS: credPath,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT || 'sebastian-hunter',
  GOOGLE_CLOUD_LOCATION: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
};

const token = execFileSync(
  'gcloud',
  ['auth', 'application-default', 'print-access-token'],
  { encoding: 'utf8', env }
).trim();

if (!token) {
  throw new Error('Vertex access token was empty');
}

for (const agent of ['x-hunter', 'x-hunter-tweet']) {
  const authPath = path.join(
    os.homedir(),
    '.openclaw',
    'agents',
    agent,
    'agent',
    'auth-profiles.json'
  );
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify({
    version: 1,
    profiles: {
      'google-vertex:manual': {
        type: 'api_key',
        provider: 'google-vertex',
        key: token,
      },
    },
    lastGood: {
      'google-vertex': 'google-vertex:manual',
    },
    usageStats: {
      'google-vertex:manual': {
        errorCount: 0,
      },
    },
  }, null, 2));
}
