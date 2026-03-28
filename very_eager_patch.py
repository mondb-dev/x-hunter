#!/usr/bin/env python3
"""Add very_eager posting cadence to cadence.js and orchestrator.js."""
import sys

# === PATCH cadence.js ===
with open('runner/cadence.js', 'r') as f:
    lines = f.readlines()

patched = False
for i, line in enumerate(lines):
    # 1. Add very_eager to VALID_EAGERNESS
    if "const VALID_EAGERNESS = ['suppress', 'normal', 'eager'];" in line:
        lines[i] = line.replace(
            "['suppress', 'normal', 'eager']",
            "['suppress', 'normal', 'eager', 'very_eager']"
        )
        patched = True
        print(f"cadence.js line {i+1}: added very_eager to VALID_EAGERNESS")
        break

if not patched:
    print("FAIL: VALID_EAGERNESS not found in cadence.js")
    sys.exit(1)

# 2. Block agent from setting very_eager (same as suppress)
patched2 = False
for i, line in enumerate(lines):
    if 'post_eagerness === "suppress"' in line:
        lines[i] = line.replace(
            'agentDirectives.post_eagerness === "suppress"',
            'agentDirectives.post_eagerness === "suppress" || agentDirectives.post_eagerness === "very_eager"'
        )
        patched2 = True
        print(f"cadence.js line {i+1}: blocked agent from setting very_eager")
        break

if not patched2:
    print("FAIL: suppress block not found in cadence.js")
    sys.exit(1)

# Also update the log message to mention very_eager
for i, line in enumerate(lines):
    if 'BLOCKED: agent requested post_eagerness=suppress' in line:
        lines[i] = line.replace(
            'post_eagerness=suppress',
            'post_eagerness=suppress/very_eager'
        )
        print(f"cadence.js line {i+1}: updated block log message")
        break

with open('runner/cadence.js', 'w') as f:
    f.writelines(lines)
print("OK: cadence.js patched")


# === PATCH orchestrator.js ===
with open('runner/orchestrator.js', 'r') as f:
    lines = f.readlines()

# Find the eager block and insert very_eager before it
patched3 = False
for i, line in enumerate(lines):
    if "cadence.post_eagerness === 'eager'" in line and 'cycle % 4' in line:
        # Insert very_eager block before this line
        indent = '  '
        very_eager_block = [
            f"{indent}} else if (cadence.post_eagerness === 'very_eager') {{\n",
            f"{indent}  // Very eager: TWEET every 3rd, QUOTE every 3rd offset 1 (~2 posts per 90min)\n",
            f"{indent}  if (cycle % 3 === 0) cycleType = 'TWEET';\n",
            f"{indent}  else if (cycle % 3 === 1) cycleType = 'QUOTE';\n",
            f"{indent}  else cycleType = 'BROWSE';\n",
        ]
        # Replace the current eager line's leading "} else if" — we need to keep
        # the structure. The current line starts the eager block. We insert before it.
        lines[i:i] = very_eager_block
        patched3 = True
        print(f"orchestrator.js: inserted very_eager block before line {i+1}")
        break

if not patched3:
    print("FAIL: eager block not found in orchestrator.js")
    sys.exit(1)

with open('runner/orchestrator.js', 'w') as f:
    f.writelines(lines)
print("OK: orchestrator.js patched")

print("Done. Verifying syntax...")
