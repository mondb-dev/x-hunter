#!/usr/bin/env python3
"""Add very_eager posting cadence to cadence.js and orchestrator.js."""
import sys

# === PATCH cadence.js ===
with open('runner/cadence.js', 'r') as f:
    lines = f.readlines()

patched = False
for i, line in enumerate(lines):
    if "const VALID_EAGERNESS = ['suppress', 'normal', 'eager'];" in line:
        lines[i] = line.replace(
            "['suppress', 'normal', 'eager']",
            "['suppress', 'normal', 'eager', 'very_eager']"
        )
        patched = True
        print("cadence.js line %d: added very_eager to VALID_EAGERNESS" % (i+1))
        break

if not patched:
    print("FAIL: VALID_EAGERNESS not found in cadence.js")
    sys.exit(1)

patched2 = False
for i, line in enumerate(lines):
    if 'post_eagerness === "suppress"' in line:
        lines[i] = line.replace(
            'agentDirectives.post_eagerness === "suppress"',
            'agentDirectives.post_eagerness === "suppress" || agentDirectives.post_eagerness === "very_eager"'
        )
        patched2 = True
        print("cadence.js line %d: blocked agent from setting very_eager" % (i+1))
        break

if not patched2:
    print("FAIL: suppress block not found in cadence.js")
    sys.exit(1)

for i, line in enumerate(lines):
    if 'BLOCKED: agent requested post_eagerness=suppress' in line:
        lines[i] = line.replace(
            'post_eagerness=suppress',
            'post_eagerness=suppress/very_eager'
        )
        print("cadence.js line %d: updated block log message" % (i+1))
        break

with open('runner/cadence.js', 'w') as f:
    f.writelines(lines)
print("OK: cadence.js patched")


# === PATCH orchestrator.js ===
with open('runner/orchestrator.js', 'r') as f:
    lines = f.readlines()

patched3 = False
for i, line in enumerate(lines):
    if "cadence.post_eagerness === 'eager'" in line and 'cycle % 4' in line:
        very_eager_block = [
            "  } else if (cadence.post_eagerness === 'very_eager') {\n",
            "    // Very eager: TWEET every 3rd, QUOTE every 3rd offset 1 (~2 posts per 90min)\n",
            "    if (cycle % 3 === 0) cycleType = 'TWEET';\n",
            "    else if (cycle % 3 === 1) cycleType = 'QUOTE';\n",
            "    else cycleType = 'BROWSE';\n",
        ]
        lines[i:i] = very_eager_block
        patched3 = True
        print("orchestrator.js: inserted very_eager block before line %d" % (i+1))
        break

if not patched3:
    print("FAIL: eager block not found in orchestrator.js")
    sys.exit(1)

with open('runner/orchestrator.js', 'w') as f:
    f.writelines(lines)
print("OK: orchestrator.js patched")

print("Done.")
