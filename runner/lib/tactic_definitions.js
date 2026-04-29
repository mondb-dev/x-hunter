'use strict';

/**
 * Defines the rhetorical tactics used to politicize justice and evade accountability.
 * These definitions are used by the tactic_tracker pipeline.
 */
const TACTICS = [
  {
    id: 'security_concerns_deflection',
    label: 'Security Concerns Deflection',
    description: 'Citing vague security threats to justify avoiding scrutiny or canceling public appearances.',
    patterns: [
      'security concerns',
      'security threat',
      'safety of my team',
      'risk of violence',
      'credible threat',
    ],
  },
  {
    id: 'selective_outrage_accusation',
    label: 'Selective Outrage Accusation',
    description: 'Accusing critics of hypocrisy or having double standards to deflect from the issue at hand.',
    patterns: [
      'selective outrage',
      'where was the outrage',
      'whataboutism',
      'partisan hypocrisy',
      'double standard',
    ],
  },
  {
    id: 'conservative_route_justification',
    label: 'Conservative Route Justification',
    description: 'Framing an action that avoids transparency as a prudent, procedural, or traditional choice.',
    patterns: [
      'conservative route',
      'procedural correctness',
      'following established process',
      'by the book',
      'abundance of caution',
    ],
  },
  {
    id: 'partisan_attack_accusation',
    label: 'Partisan Attack / Witch Hunt Accusation',
    description: 'Dismissing legitimate inquiries or legal processes as politically motivated attacks.',
    patterns: [
      'witch hunt',
      'partisan attack',
      'political persecution',
      'weaponization of justice',
      'politically motivated',
      'political vendetta',
      'smear campaign',
    ],
  },
  {
    id: 'political_theater_accusation',
    label: 'Political Theater Accusation',
    description: 'Labeling accountability efforts as performative or insincere spectacles for political gain.',
    patterns: [
      'political theater',
      'show trial',
      'for the cameras',
      'performative outrage',
      'grandstanding',
    ],
  },
];

module.exports = TACTICS;
