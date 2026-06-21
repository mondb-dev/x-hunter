# Sebastian runner hang-guard

External watchdog that restarts `sebastian-runner` if it hangs (process alive but
not cycling). Covers the failure mode seen 2026-06-21, where the orchestrator
stalled after a failed git commit and sat dead for ~8h while systemd still
reported it `active` (so `Restart=always` did not help — it only catches exits,
not hangs).

## How it works
`sebastian-watchdog.timer` runs `sebastian-watchdog.sh` every 15 min. The script
checks the mtime of `runner/orchestrator.log`; if it's stale > 120 min (safely
above max cycle ~17m + max inter-cycle wait 60m) it restarts the runner. Otherwise
it logs `ok` to syslog (tag `sebastian-watchdog`).

## Install (on the VM)
```bash
sudo cp sebastian-watchdog.sh /usr/local/bin/ && sudo chmod +x /usr/local/bin/sebastian-watchdog.sh
sudo cp sebastian-watchdog.service sebastian-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sebastian-watchdog.timer
```

## Check
```bash
systemctl list-timers sebastian-watchdog.timer
journalctl -t sebastian-watchdog -n 5
```
