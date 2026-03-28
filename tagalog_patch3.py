#!/usr/bin/env python3
"""Patch tweet.js and quote.js with improved Tagalog/Filipino language guidance.
Uses line-by-line replacement to avoid string matching issues."""
import sys

# === PATCH tweet.js ===
with open('runner/lib/prompts/tweet.js', 'r') as f:
    lines = f.readlines()

# Find the line with "j. TAGALOG RULE:"
tagalog_start = None
tagging_start = None
for i, line in enumerate(lines):
    if 'j. TAGALOG RULE:' in line:
        tagalog_start = i
    if 'k. TAGGING RULE:' in line:
        tagging_start = i
        break

if tagalog_start is None or tagging_start is None:
    print(f"FAIL tweet.js: tagalog_start={tagalog_start}, tagging_start={tagging_start}")
    sys.exit(1)

print(f"tweet.js: replacing lines {tagalog_start+1}-{tagging_start} (0-indexed)")

new_tagalog_lines = [
    "    '   j. TAGALOG RULE: If the tweet topic is primarily about the Philippines, Filipino\\n' +\n",
    "    '      politics, PH governance, OFW issues, or Filipino culture \\u2014 write the tweet in\\n' +\n",
    "    '      natural spoken Tagalog or Taglish (Tagalog-English mix). Taglish is the default \\u2014\\n' +\n",
    "    '      code-switching between Tagalog and English is how Filipinos actually talk online.\\n' +\n",
    "    '      NEVER write formal/academic/textbook Tagalog. Sebastian speaks like a regular\\n' +\n",
    "    '      Filipino on Twitter \\u2014 casual, direct, may use slang and contractions.\\n' +\n",
    "    '      BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis\\n' +\n",
    "    '        ay kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n",
    "    '      GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng\\n' +\n",
    "    '        buong picture bago mag-judge.\"\\n' +\n",
    "    '      GOOD (casual Tagalog): \"Oo connected naman. Pero yung global side, ang labo\\n' +\n",
    "    '        pa rin \\u2014 hindi pwedeng isang angle lang.\"\\n' +\n",
    "    '      Rules: Use \"yung\" not \"ang\" for casual reference. Use \"di/hindi\" not\\n' +\n",
    "    '      \"hindi naman\" for negation. Mix English nouns/terms freely (\"oil prices\",\\n' +\n",
    "    '      \"context\", \"debate\"). Short punchy sentences. No formal conjunctions like\\n' +\n",
    "    '      \"samakatuwid\" or \"gayunpaman\". Think: how would a sharp Filipino tweet this?\\n' +\n",
]

lines[tagalog_start:tagging_start] = new_tagalog_lines

with open('runner/lib/prompts/tweet.js', 'w') as f:
    f.writelines(lines)
print(f'OK: tweet.js patched ({len(new_tagalog_lines)} lines replacing {tagging_start - tagalog_start} old lines)')


# === PATCH quote.js ===
with open('runner/lib/prompts/quote.js', 'r') as f:
    lines = f.readlines()

# Find the line with "rewrite it." (end of VOICE block)
voice_end = None
for i, line in enumerate(lines):
    if 'rewrite it.' in line and 'VOICE' not in line:
        voice_end = i
        break

if voice_end is None:
    # Try alternate search
    for i, line in enumerate(lines):
        if 'rewrite it' in line:
            voice_end = i
            break

if voice_end is None:
    print("FAIL quote.js: could not find VOICE end marker")
    sys.exit(1)

print(f"quote.js: inserting after line {voice_end+1} (0-indexed)")

tagalog_lines = [
    "    '   TAGALOG RULE: If the quoted tweet is in Tagalog/Filipino, or is about the Philippines,\\n' +\n",
    "    '   Filipino politics, PH governance, OFW issues, or Filipino culture \\u2014 write your\\n' +\n",
    "    '   quote commentary in natural spoken Tagalog or Taglish (Tagalog-English code-switch).\\n' +\n",
    "    '   NEVER write formal/academic/textbook Tagalog. Nobody on Filipino Twitter talks like that.\\n' +\n",
    "    '   BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis ay\\n' +\n",
    "    '     kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n",
    "    '   GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng buong\\n' +\n",
    "    '     picture bago mag-judge.\"\\n' +\n",
    "    '   GOOD (casual): \"Oo connected naman. Pero yung global side, ang labo pa rin \\u2014\\n' +\n",
    "    '     hindi pwedeng isang angle lang.\"\\n' +\n",
    "    '   Rules: Use \"yung\" not \"ang\" for casual. Mix English nouns freely. Short punchy\\n' +\n",
    "    '   sentences. No formal words like \"samakatuwid\", \"gayunpaman\", \"pandaigdigan\".\\n' +\n",
    "    '   Think: how would a sharp Filipino quote-tweet this?\\n' +\n",
]

# Insert after voice_end + 1
lines[voice_end+1:voice_end+1] = tagalog_lines

with open('runner/lib/prompts/quote.js', 'w') as f:
    f.writelines(lines)
print(f'OK: quote.js patched ({len(tagalog_lines)} lines inserted)')

print('Done.')
