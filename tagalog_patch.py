#!/usr/bin/env python3
"""Patch tweet.js and quote.js with improved Tagalog/Filipino language guidance."""

import sys

# === PATCH tweet.js ===
with open('runner/lib/prompts/tweet.js', 'r') as f:
    tw = f.read()

old_tw = (
    "'   j. TAGALOG RULE: If the tweet topic is primarily about the Philippines, Filipino\\n' +\n"
    "'      politics, PH governance, OFW issues, or Filipino culture \\u2014 write the tweet in\\n' +\n"
    "'      Tagalog or Taglish (Tagalog-English mix). Full Tagalog for emotional/cultural\\n' +\n"
    "'      takes, Taglish for technical or cross-cultural observations. Sebastian\\'s Tagalog\\n' +\n"
    "'      is direct, not formal \\u2014 \"walang halong takot\".\\n' +"
)

new_tw = (
    "'   j. TAGALOG RULE: If the tweet topic is primarily about the Philippines, Filipino\\n' +\n"
    "'      politics, PH governance, OFW issues, or Filipino culture \\u2014 write the tweet in\\n' +\n"
    "'      natural spoken Tagalog or Taglish (Tagalog-English mix). Taglish is the default \\u2014\\n' +\n"
    "'      code-switching between Tagalog and English is how Filipinos actually talk online.\\n' +\n"
    "'      NEVER write formal/academic/textbook Tagalog. Sebastian speaks like a regular\\n' +\n"
    "'      Filipino on Twitter \\u2014 casual, direct, may use slang and contractions.\\n' +\n"
    "'      BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis\\n' +\n"
    "'        ay kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n"
    "'      GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng\\n' +\n"
    "'        buong picture bago mag-judge.\"\\n' +\n"
    "'      GOOD (casual Tagalog): \"Oo connected naman. Pero yung global side, ang labo\\n' +\n"
    "'        pa rin \\u2014 hindi pwedeng isang angle lang.\"\\n' +\n"
    "'      Rules: Use \"yung\" not \"ang\" for casual reference. Use \"di/hindi\" not\\n' +\n"
    "'      \"hindi naman\" for negation. Mix English nouns/terms freely (\"oil prices\",\\n' +\n"
    "'      \"context\", \"debate\"). Short punchy sentences. No formal conjunctions like\\n' +\n"
    "'      \"samakatuwid\" or \"gayunpaman\". Think: how would a sharp Filipino tweet this?\\n' +"
)

if old_tw in tw:
    tw = tw.replace(old_tw, new_tw)
    with open('runner/lib/prompts/tweet.js', 'w') as f:
        f.write(tw)
    print('OK: tweet.js patched')
else:
    print('FAIL: old string not found in tweet.js')
    idx = tw.find('TAGALOG')
    if idx >= 0:
        print('Context around TAGALOG:')
        print(repr(tw[idx-20:idx+500]))
    sys.exit(1)


# === PATCH quote.js ===
with open('runner/lib/prompts/quote.js', 'r') as f:
    qt = f.read()

# Insert Tagalog rule after the VOICE line in quote.js
voice_anchor = (
    "'   VOICE: Write like a person, not an analyst. Short, direct sentences. Say what the tweet\\n' +\n"
    "'   claims, then say what you actually think about it. If it sounds like a report, rewrite it.\\n' +"
)

tagalog_block = (
    "'   VOICE: Write like a person, not an analyst. Short, direct sentences. Say what the tweet\\n' +\n"
    "'   claims, then say what you actually think about it. If it sounds like a report, rewrite it.\\n' +\n"
    "'   TAGALOG RULE: If the quoted tweet is in Tagalog/Filipino, or is about the Philippines,\\n' +\n"
    "'   Filipino politics, PH governance, OFW issues, or Filipino culture \\u2014 write your\\n' +\n"
    "'   quote commentary in natural spoken Tagalog or Taglish (Tagalog-English code-switch).\\n' +\n"
    "'   NEVER write formal/academic/textbook Tagalog. Nobody on Filipino Twitter talks like that.\\n' +\n"
    "'   BAD (stiff/Google Translate): \"Ang dinamika ng pandaigdigang presyo ng langis ay\\n' +\n"
    "'     kumplikado. Mahalaga ang buong konteksto sa debate na ito.\"\\n' +\n"
    "'   GOOD (natural Taglish): \"Di ganun kasimple yung oil prices. Kailangan ng buong\\n' +\n"
    "'     picture bago mag-judge.\"\\n' +\n"
    "'   GOOD (casual): \"Oo connected naman. Pero yung global side, ang labo pa rin \\u2014\\n' +\n"
    "'     hindi pwedeng isang angle lang.\"\\n' +\n"
    "'   Rules: Use \"yung\" not \"ang\" for casual. Mix English nouns freely. Short punchy\\n' +\n"
    "'   sentences. No formal words like \"samakatuwid\", \"gayunpaman\", \"pandaigdigan\".\\n' +\n"
    "'   Think: how would a sharp Filipino quote-tweet this?\\n' +"
)

if voice_anchor in qt:
    qt = qt.replace(voice_anchor, tagalog_block)
    with open('runner/lib/prompts/quote.js', 'w') as f:
        f.write(qt)
    print('OK: quote.js patched')
else:
    print('FAIL: voice anchor not found in quote.js')
    idx = qt.find('VOICE')
    if idx >= 0:
        print('Context around VOICE:')
        print(repr(qt[idx-20:idx+300]))
    sys.exit(1)

print('Done.')
