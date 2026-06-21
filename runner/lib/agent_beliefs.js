'use strict';

/**
 * @fileoverview Defines structured taxonomies for agent beliefs,
 * including the framework for analyzing dissent framing.
 */

const DISSENT_NATURES = {
  POLITICAL: 'political', // e.g., election integrity, policy opposition
  SOCIAL: 'social', // e.g., civil rights, social justice
  ECONOMIC: 'economic', // e.g., labor strikes, tax protests
  ENVIRONMENTAL: 'environmental', // e.g., climate change, conservation
  GEOPOLITICAL: 'geopolitical', // e.g., anti-war, sovereignty
  OTHER: 'other',
};

const FRAMING_TACTICS = {
  DEMONIZATION: 'demonization', // Portraying participants as evil, immoral, or dangerous
  DELEGITIMIZATION: 'delegitimization', // Questioning the motives, authenticity, or support of the dissent
  CRIMINALIZATION: 'criminalization', // Framing protest as illegal activity rather than civic expression
  MINIMIZATION: 'minimization', // Downplaying the scale, scope, or importance of the dissent
  DISTRACTION: 'distraction', // Shifting focus to irrelevant details or secondary issues
  CO_OPTION: 'co-option', // Absorbing or appropriating the dissent's message to neutralize it
  FEAR_MONGERING: 'fear_mongering', // Instilling fear about the consequences of the dissent
  PATRIOTIC_FRAMING: 'patriotic_framing', // Framing dissent as unpatriotic or a threat to the nation
  AGENT_PROVOCATEUR: 'agent_provocateur_accusation', // Claiming violence/illegality is caused by infiltrators
};

const FRAMING_SOURCES = {
  STATE_ACTORS: 'state_actors', // e.g., government officials, police departments
  STATE_MEDIA: 'state_media', // Government-controlled or heavily influenced media
  CORPORATE_MEDIA: 'corporate_media', // Privately owned, mainstream media outlets
  INDEPENDENT_MEDIA: 'independent_media', // Alternative, non-mainstream media
  COUNTER_PROTESTERS: 'counter_protesters', // Organized or organic groups opposing the dissent
  POLITICAL_OPPONENTS: 'political_opponents', // Rival political parties or figures
  SOCIAL_MEDIA_INFLUENCERS: 'social_media_influencers', // Influential accounts on social platforms
  UNAFFILIATED_PUBLIC: 'unaffiliated_public', // General public commentary
};

const FRAMING_GOALS = {
  SUPPRESS_PARTICIPATION: 'suppress_participation', // Discourage people from joining or supporting
  JUSTIFY_FORCE: 'justify_force', // Create a pretext for using force against participants
  SHIFT_BLAME: 'shift_blame', // Blame dissenters for societal problems or violence
  ERODE_PUBLIC_SUPPORT: 'erode_public_support', // Turn public opinion against the cause
  MAINTAIN_STATUS_QUO: 'maintain_status_quo', // Preserve existing power structures and policies
  DISCREDIT_LEADERSHIP: 'discredit_leadership', // Target and undermine protest leaders
};

/**
 * A schema for a structured analysis of dissent framing in an observation.
 * @typedef {Object} DissentFramingAnalysis
 * @property {boolean} is_dissent_related - Whether the observation is related to dissent/protest.
 * @property {string} [nature] - The nature of the dissent. From DISSENT_NATURES.
 * @property {string[]} [tactics] - Framing tactics used. From FRAMING_TACTICS.
 * @property {string[]} [sources] - The source of the framing. From FRAMING_SOURCES.
 * @property {string[]} [goals] - The perceived goal of the framing. From FRAMING_GOALS.
 * @property {string} [summary] - A brief summary of the framing.
 */

module.exports = {
  DISSENT_NATURES,
  FRAMING_TACTICS,
  FRAMING_SOURCES,
  FRAMING_GOALS,
};
