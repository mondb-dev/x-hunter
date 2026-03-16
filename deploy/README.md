# Deploying Sebastian to GCP

## Overview

Three scripts run in order:

| Script | Where it runs | What it does |
|---|---|---|
| `01-create-vm.sh` | Local (Mac) | Creates GCP project + e2-medium VM |
| `02-migrate-data.sh` | Local (Mac) | Transfers code, secrets, Chrome profile, databases |
| `03-install.sh` | Remote (VM) | Installs Node.js, Chrome, OpenClaw, systemd services |

**Estimated cost:** ~$24/mo (e2-medium, us-central1, 30 GB SSD)

## Prerequisites

1. **gcloud CLI** installed and authenticated:
   ```bash
   # Install: https://cloud.google.com/sdk/docs/install
   gcloud auth login
   ```

2. **Billing account** linked to a GCP project (script will prompt)

## Step-by-step

### 1. Create the VM

```bash
cd ~/Documents/Projects/hunter
bash deploy/01-create-vm.sh
```

This creates:
- GCP project `sebastian-hunter` (or uses existing)
- e2-medium VM named `sebastian` in us-central1-a
- SSH firewall rule

### 2. Migrate data

```bash
bash deploy/02-migrate-data.sh
```

This transfers:
- Git repo (cloned fresh on VM)
- `.env` (all API keys and secrets)
- Vertex AI service account JSON
- Chrome browser profile (~1.2 GB compressed — preserves X login cookies)
- OpenClaw agent configs (patched paths for Linux)
- `state/index.db` (~160 MB SQLite — memory, FTS5 index)
- Gitignored state files (reply queue, ponder state, etc.)

### 3. SSH into VM and install

```bash
gcloud compute ssh sebastian --zone=us-central1-a
cd ~/hunter
bash deploy/03-install.sh
```

This installs:
- Node.js 24
- Google Chrome (headless-capable)
- OpenClaw CLI + gateway daemon
- npm dependencies (scraper + runner)
- Two systemd services

### 4. Start Sebastian

```bash
sudo systemctl start openclaw-gateway
sudo systemctl start sebastian-runner
```

Check it's running:
```bash
sudo systemctl status sebastian-runner
tail -30 ~/hunter/runner/runner.log
```

## Systemd services

| Service | Description | Depends on |
|---|---|---|
| `openclaw-gateway` | OpenClaw gateway (port 18789) | network |
| `sebastian-runner` | Main agent loop (run.sh) | openclaw-gateway |

**Commands:**
```bash
sudo systemctl status sebastian-runner   # Check status
sudo systemctl restart sebastian-runner  # Restart runner
sudo journalctl -u sebastian-runner -f   # Follow systemd journal
tail -f ~/hunter/runner/runner.log       # Runner's own log
```

## Maintenance

### Updating code

```bash
gcloud compute ssh sebastian --zone=us-central1-a
cd ~/hunter && git pull
sudo systemctl restart sebastian-runner
```

### Viewing logs

```bash
# Runner log (most useful)
tail -100 ~/hunter/runner/runner.log

# Gateway log
tail -50 ~/.openclaw-x-hunter/logs/gateway.log

# Systemd journal
sudo journalctl -u sebastian-runner --since "1 hour ago"
```

### Pausing/resuming

```bash
# Pause (runner sleeps, doesn't exit)
touch ~/hunter/runner/PAUSE

# Resume
rm ~/hunter/runner/PAUSE
```

### If Chrome session expires (X login cookies)

```bash
sudo systemctl stop sebastian-runner
openclaw browser --browser-profile x-hunter start
openclaw browser --browser-profile x-hunter open https://x.com/login
# Log in manually via VNC or Chrome remote debugging
openclaw browser --browser-profile x-hunter stop
sudo systemctl start sebastian-runner
```

## Architecture on VM

```
systemd
  ├── openclaw-gateway.service  (port 18789, restarts on crash)
  └── sebastian-runner.service  (run.sh, restarts on crash)
        ├── scraper/collect.js  (background, every 10 min)
        ├── scraper/reply.js    (background, every 30 min)
        ├── scraper/follows.js  (background, every 3 hours)
        └── agent cycle         (every 30 min via openclaw agent)
              ├── BROWSE ×5     (observe, read, update ontology)
              └── TWEET ×1      (synthesize, journal, tweet, git push)
```

## Cost breakdown

| Resource | Monthly cost |
|---|---|
| e2-medium VM (2 vCPU, 4 GB) | ~$24 |
| 30 GB SSD | ~$2.40 |
| Egress (minimal — git push, API calls) | ~$0.50 |
| **Total** | **~$27** |

Gemini API costs are separate (billed to your Google AI API keys).

## Environment variables

All secrets are in `~/hunter/.env` on the VM. Key variables:

| Variable | Purpose |
|---|---|
| `GOOGLE_API_KEY` | OpenClaw browse agent |
| `GOOGLE_API_KEY_BROWSE` | Browse agent (alternate) |
| `GOOGLE_API_KEY_TWEET` | Tweet/reply generation |
| `GOOGLE_API_KEY_REFLECTION` | Critique, voice filter, embeddings |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex AI (checkpoints, articles) |
| `GITHUB_TOKEN` | Git push (auto-commit journals) |
| `X_USERNAME` / `X_PASSWORD` | X credentials (backup login) |
| `MOLTBOOK_API_KEY` | Moltbook social log |
| `SOLANA_PRIVATE_KEY` | Arweave uploads via Irys |
