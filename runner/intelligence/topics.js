'use strict';

/**
 * runner/intelligence/topics.js
 *
 * Topic definitions for the intelligence pipeline.
 * Each topic has: id, label, keyword matchers, categories, and relevant ontology axes.
 */

const TOPICS = {
  'iran-us-israel': {
    id: 'iran-us-israel',
    label: 'Iran / US / Israel: Conflict Intelligence',
    keywords: [
      'iran', 'iranian', 'irgc', 'khamenei', 'raisi', 'pezeshkian', 'tehran',
      'israel', 'israeli', 'idf', 'netanyahu', 'mossad', 'tel aviv',
      'hezbollah', 'hamas', 'houthi', 'houthis', 'ansarallah',
      'gaza', 'west bank', 'rafah', 'golan', 'lebanon',
      'nuclear', 'uranium', 'enrichment', 'natanz', 'fordow', 'centrifuge',
      'us strike', 'pentagon', 'centcom', 'sanctions', 'regime change',
      'proxy', 'axis of resistance', 'us air force', 'b-2', 'bunker buster',
      'war', 'ceasefire', 'hostage', 'captive', 'prisoner',
    ],
    topic_axes: [
      'axis_geopolitical_rhetoric_v1',
      'axis_national_sovereignty_v_intl_law_v1',
      'axis_global_power_realignments_v1',
      'axis_religion_politics_war_v1',
    ],
    categories: {
      nuclear: {
        label: 'Nuclear Program',
        keywords: [
          'nuclear', 'uranium', 'enrichment', 'natanz', 'fordow', 'centrifuge',
          'breakout', 'iaea', 'npt', 'bomb', 'warhead', 'fissile', 'plutonium',
          'reactor', 'enriched', 'proliferation', 'inspectors', 'safeguards',
          'jcpoa', 'deal', 'enrichment level', 'percent',
        ],
      },
      military_action: {
        label: 'Military Action',
        keywords: [
          'strike', 'attack', 'bomb', 'missile', 'drone', 'air force',
          'military', 'troops', 'invasion', 'offensive', 'defense', 'idf operation',
          'airstrike', 'shelling', 'rocket', 'intercept', 'arrow', 'iron dome',
          'centcom', 'b-2', 'bunker', 'explosion', 'destroyed', 'hit', 'targeted',
          'retaliation', 'escalation', 'ground operation', 'navy', 'carrier',
        ],
      },
      diplomatic: {
        label: 'Diplomacy & Negotiations',
        keywords: [
          'diplomatic', 'diplomacy', 'talks', 'negotiat', 'deal', 'agreement',
          'ceasefire', 'truce', 'peace', 'envoy', 'ambassador', 'un security',
          'resolution', 'veto', 'sanctions', 'lifting sanctions', 'normalization',
          'two-state', 'accord', 'mediation', 'qatar', 'oman', 'switzerland',
          'foreign minister', 'secretary of state', 'state department',
        ],
      },
      casualties_humanitarian: {
        label: 'Casualties & Humanitarian',
        keywords: [
          'killed', 'dead', 'casualties', 'civilian', 'wounded', 'injur',
          'hospital', 'aid', 'humanitarian', 'famine', 'starvation', 'blockade',
          'displacement', 'refugee', 'unrwa', 'icrc', 'red cross', 'death toll',
          'mass grave', 'genocide', 'war crime', 'civilian deaths', 'bodies',
          'children killed', 'massacre', 'hostage', 'captive', 'prisoner',
        ],
      },
      proxy_regional: {
        label: 'Proxy Forces & Regional',
        keywords: [
          'hezbollah', 'hamas', 'houthi', 'houthis', 'ansarallah',
          'pij', 'islamic jihad', 'popular mobilization', 'pmu', 'hashd',
          'proxy', 'axis of resistance', 'red sea', 'strait of hormuz',
          'shipping', 'tanker', 'oil', 'maritime', 'corridor',
          'lebanon', 'syria', 'iraq', 'yemen', 'west bank', 'gaza tunnel',
          'kataib', 'militia', 'armed group',
        ],
      },
      threats_claims: {
        label: 'Threats & Claims',
        keywords: [
          'threat', 'warn', 'ultimatum', 'declar', 'vow', 'pledg',
          'retaliat', 'revenge', 'promised', 'will attack', 'prepare',
          'claim', 'assert', 'allege', 'deny', 'accus',
          'propaganda', 'disinformation', 'false flag', 'fabricat',
          'intelligence', 'spy', 'covert', 'sabotage',
        ],
      },
      internal_politics: {
        label: 'Internal Politics',
        keywords: [
          'election', 'coalition', 'cabinet', 'parliament', 'knesset',
          'protest', 'demonstration', 'opposition', 'government', 'minister',
          'political', 'domestic', 'public opinion', 'approval', 'poll',
          'reform', 'hardliner', 'moderate', 'conservative', 'revolutionary guard',
          'supreme leader', 'president', 'prime minister', 'netanyahu trial',
          'corruption', 'judicial', 'constitution',
        ],
      },
    },
  },
};

/**
 * Check a text against a topic's keywords.
 * Returns true if ≥1 keyword matches.
 */
function matchesTopic(topicId, text) {
  const topic = TOPICS[topicId];
  if (!topic) return false;
  const lower = text.toLowerCase();
  return topic.keywords.some(kw => lower.includes(kw));
}

/**
 * Categorize text against topic categories.
 * Returns the best-matching category id, or 'misc' if none match.
 *
 * Scoring: count how many keywords match per category,
 * return the category with the most hits.
 */
function matchCategories(topicId, text) {
  const topic = TOPICS[topicId];
  if (!topic) return 'misc';
  const lower = text.toLowerCase();

  let bestCat = 'misc';
  let bestScore = 0;

  for (const [catId, cat] of Object.entries(topic.categories)) {
    const score = cat.keywords.filter(kw => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestCat = catId;
    }
  }

  return bestCat;
}

module.exports = { TOPICS, matchesTopic, matchCategories };
