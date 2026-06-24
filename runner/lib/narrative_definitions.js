'use strict';

// Defines the structured vocabulary for narrative manipulation tactics and purposes.
// This allows for consistent logging and analysis.

const MANIPULATION_PURPOSES = [
  'Deflect Accountability',
  'Justify Action',
  'Manufacture Consent',
  'Discredit Opponent',
  'Sow Division',
  'Control Narrative',
  'Obscure Truth',
  'Undermine Institution',
];

const SPECIFIC_TACTICS = [
  'Evidentiary Inversion', // Building a case after guilt is decided
  'Cherry-Picking Data', // Selecting evidence that supports a pre-determined conclusion
  'Ad Hominem Attack on Source', // Discrediting the messenger instead of the message
  'False Flag Framing', // Attributing actions to an opponent to discredit them
  'Manufactured Crisis', // Exaggerating or fabricating a threat to justify a response
  'Emotional Appeal', // Using emotionally charged language to bypass rational thought
  'Strawman Argument', // Misrepresenting an opponent's argument to make it easier to attack
  'Whataboutism', // Deflecting criticism by pointing to an unrelated issue
  'Gaslighting', // Manipulating someone into questioning their own sanity or reality
  'Repetitive Assertion', // Repeating a claim so often it is accepted as truth
  'Gish Gallop', // Overwhelming an opponent with a barrage of individually weak arguments
  'False Equivalence', // Implying that two unequal things are the same
];

module.exports = {
  MANIPULATION_PURPOSES,
  SPECIFIC_TACTICS,
};
