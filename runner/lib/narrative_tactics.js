'use strict';

/**
 * A catalog of known narrative manipulation tactics.
 * This list is used by tools and agents to categorize and analyze discourse.
 */
const NARRATIVE_TACTICS = [
  {
    id: 'deflection_false_claims',
    name: 'Deflection via False Claims',
    description: 'Diverting attention from a core issue by introducing unrelated or false information, often to attack an opponent or change the subject.',
    keywords: ['fake news', 'trolls', 'distraction', 'what about', 'deflection']
  },
  {
    id: 'framing_victim_hero',
    name: 'Framing as Victim/Hero',
    description: 'Casting oneself or one\'s group as a persecuted victim or a lone hero fighting against overwhelming odds, to generate sympathy and delegitimize opponents.',
    keywords: ['victim', 'hero', 'witch hunt', 'deep state', 'persecuted', 'fighting for you']
  },
  {
    id: 'appeal_to_emotion_fear',
    name: 'Appeal to Emotion/Fear',
    description: 'Using emotionally charged language or imagery to bypass rational analysis and provoke a strong emotional response, such as fear, anger, or patriotism.',
    keywords: ['outrage', 'danger', 'threat', 'disaster', 'protect the children', 'our values']
  },
  {
    id: 'gaslighting',
    name: 'Gaslighting',
    description: 'Manipulating someone into questioning their own sanity, perception of reality, or memories. Denying events that occurred or inventing new ones.',
    keywords: ['you\'re crazy', 'that never happened', 'you\'re imagining things', 'misremembering', 'overreacting']
  },
  {
    id: 'whataboutism',
    name: 'Whataboutism',
    description: 'A specific form of deflection that responds to an accusation or difficult question by making a counter-accusation or raising a different issue.',
    keywords: ['what about', 'but they did', 'you also', 'hypocrite']
  },
  {
    id: 'splicing_doctoring_evidence',
    name: 'Splicing/Doctoring Evidence',
    description: 'Editing or presenting media (video, audio, images) or documents in a misleading way to distort the original meaning or create a false narrative.',
    keywords: ['spliced', 'doctored', 'edited', 'out of context', 'manipulated video', 'selective editing']
  },
  {
    id: 'manufacturing_consent',
    name: 'Manufacturing Consent',
    description: 'Creating the illusion of widespread popular support for a policy or viewpoint through propaganda, coordinated messaging, or astroturfing.',
    keywords: ['silent majority', 'everyone knows', 'people are saying', 'astroturf', 'paid protesters']
  },
  {
    id: 'weaponization_of_identity',
    name: 'Weaponization of Identity/Religion',
    description: 'Using identity markers (religion, nationality, ethnicity, faith) to create an "us vs. them" dynamic, justify actions, or attack opponents.',
    keywords: ['weaponize faith', 'not a true believer', 'god\'s will', 'traitor', 'unpatriotic']
  },
];

module.exports = {
  NARRATIVE_TACTICS,
};
