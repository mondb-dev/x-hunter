#!/usr/bin/env python3
"""Patch tweet.js and quote.js with improved Tagalog/Filipino language guidance."""
import sys

# === PATCH tweet.js ===
with open('runner/lib/prompts/tweet.js', 'r') as f:
    tw = f.read()

# Find the old tagalog block by searching between markers
start_marker = "j. TAGALOG RULE:"
end_marker = "k. TAGGING RULE:"

si = tw.find(start_marker)
ei = tw.find(end_marker)

if si < 0 or ei < 0:
    print("FAIL: Could not find TAGALOG or TAGGING markers in tweet.js")
    sys.exit(1)

# Go back to the start of the line containing start_marker
line_start = tw.rfind("'   j.", 0, si)
# End right before the line with end_marker
line_end = tw.rfind("'   k.", 0, ei)

old_block = tw[line_start:line_end]
print("OLD tweet.js block found, length:", len(old_block))

new_block = (
    "'   j. TAGALOG RULE: If the tweet topic is primarily about the Philippines, Filipino\\n' +\n"
    "    '      politics, PH governance, OFW issues, or Filipino culture \\u2014 write the tweet in\\n' +\n"
    "    '      natural spoken Tagalog or Taglish (Tagalog-English mix). Taglish is the default \\u2014\\n' +\n"
    "    '      code-switching between Tagalog and English is how Filipinos actually talk online.\\n' +\n"
    "    '      NEVER write formal/academic/textbook Tagalog. Sebastian speaks like a regular\\n' +\n"
    "    '      Filipino on Twitter \\u2014 casual, direct, may use slang and contractions.\\n' +\n"
    "    '      BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis\\n' +\n"
    "    '        ay kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n"
    "    '      GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng\\n' +\n"
    "    '        buong picture bago mag-judge.\"\\n' +\n"
    "    '      GOOD (casual Tagalog): \"Oo connected naman. Pero yung global side, ang labo\\n' +\n"
    "    '        pa rin \\u2014 hindi pwedeng isang angle lang.\"\\n' +\n"
    "    '      Rules: Use \"yung\" not \"ang\" for casual reference. Use \"di/hindi\" not\\n' +\n"
    "    '      \"hindi naman\" for negation. Mix English nouns/terms freely (\"oil prices\",\\n' +\n"
    "    '      \"context\", \"debate\"). Short punchy sentences. No formal conjunctions like\\n' +\n"
    "    '      \"samakatuwid\" or \"gayunpaman\". Think: how would a sharp Filipino tweet this?\\n' +\n"
    "    "
)

tw = tw[:line_start] + new_block + tw[line_end:]

with open('runner/lib/prompts/tweet.js', 'w') as f:
    f.write(tw)
print('OK: tweet.js patched')


# === PATCH quote.js ===
with open('runner/lib/prompts/quote.js', 'r') as f:
    qt = f.read()

# Find the VOICE line and insert TAGALOG rule after it
voice_marker = "VOICE: Write like a person"
vi = qt.find(voice_marker)
if vi < 0:
    print("FAIL: VOICE marker not found in quote.js")
    sys.exit(1)

# Find the end of the VOICE block (the line ending with "rewrite it.\n' +")
rewrite_marker = "rewrite it.\\n' +"
ri = qt.find(rewrite_marker, vi)
if ri < 0:
    print("FAIL: rewrite marker not found in quote.js")
    sys.exit(1)

# Insert after the rewrite line
insert_point = ri + len(rewrite_marker)
# Skip to end of actual line in source
newline_after = qt.find('\n', insert_point)
if newline_after < 0:
    newline_after = insert_point

tagalog_insert = (
    "\n"
    "    '   TAGALOG RULE: If the quoted tweet is in Tagalog/Filipino, or is about the Philippines,\\n' +\n"
    "    '   Filipino politics, PH governance, OFW issues, or Filipino culture \\u2014 write your\\n' +\n"
    "    '   quote commentary in natural spoken Tagalog or Taglish (Tagalog-English code-switch).\\n' +\n"
    "    '   NEVER write formal/academic/textbook Tagalog. Nobody on Filipino Twitter talks like that.\\n' +\n"
    "    '   BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis ay\\n' +\n"
    "    '     kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n"
    "    '   GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng buong\\n' +\n"
    "    '     picture bago mag-judge.\"\\n' +\n"
    "    '   GOOD (casual): \"Oo connected naman. Pero yung global side, ang labo pa rin \\u2014\\n' +\n"
    "    '     hindi pwedeng isang angle lang.\"\\n' +\n"
    "    '   Rules: Use \"yung\" not \"ang\" for casual. Mix English nouns freely. Short punchy\\n' +\n"
    "    '   sentences. No formal words like \"samakatuwid\", \"gayunpaman\", \"pandaigdigan\".\\n' +\n"
    "    '   Think: how would a sharp Filipino quote-tweet this?\\n' +"
)

qt = qt[:newline_after] + tagalog_insert + qt[newline_after:]

with open('runner/lib/prompts/quote.js', 'w') as f:
    f.write(qt)
print('OK: quote.js patched')

print('Done. Both files patched.')
