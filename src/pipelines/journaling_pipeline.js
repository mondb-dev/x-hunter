'use strict';

const fs = require('fs');
const path = require('path');

const RATIONALE_PROMPT_PATH = path.join(__dirname, '../prompts/journal_entry_generator.txt');
const AUDITOR_PROMPT_PATH = path.join(__dirname, '../prompts/journal_valence_auditor.txt');

/**
 * The journaling pipeline is responsible for analyzing new evidence against
 * existing belief axes and generating proposed updates.
 *
 * This implementation introduces a two-step process:
 * 1. Rationale Generation: An initial LLM call generates a justification for an update.
 * 2. Valence Audit: A second, adversarial LLM call audits the rationale and evidence
 *    to determine the correct direction (valence) and magnitude of the update.
 *
 * This separation is designed to prevent logical errors where the belief score
 * moves in a direction opposite to what the evidence implies.
 */
class JournalingPipeline {
    /**
     * @param {object} options
     * @param {object} options.llm - An LLM interface with a `call(prompt)` method.
     * @param {object} options.logger - A logger object with `log`, `warn`, `error`.
     */
    constructor({ llm, logger }) {
        if (!llm || !logger) {
            throw new Error('JournalingPipeline requires llm and logger in constructor options.');
        }
        this.llm = llm;
        this.logger = logger;

        // Prompts are loaded once during initialization.
        try {
            this.rationalePrompt = fs.readFileSync(RATIONALE_PROMPT_PATH, 'utf-8');
            this.auditorPrompt = fs.readFileSync(AUDITOR_PROMPT_PATH, 'utf-8');
        } catch (error) {
            this.logger.error('Failed to load journaling pipeline prompts.', error);
            throw error; // Fail fast if prompts are missing
        }
    }

    /**
     * Processes a single piece of evidence against a relevant belief axis.
     * @param {object} axis - The belief axis from ontology.json.
     * @param {string} evidence - The text content of the evidence to be analyzed.
     * @returns {Promise<object|null>} A proposed update object or null if the process fails.
     */
    async processEvidence(axis, evidence) {
        try {
            this.logger.log(`[JournalingPipeline] Processing evidence for axis: "${axis.label}"`);

            // Step 1: Generate Rationale
            const rationale = await this.generateRationale(axis, evidence);
            if (!rationale) {
                this.logger.warn('[JournalingPipeline] Failed to generate rationale.');
                return null;
            }
            this.logger.log(`[JournalingPipeline] Generated rationale: "${rationale}"`);


            // Step 2: Perform Valence Audit
            const auditResult = await this.performValenceAudit(axis, evidence, rationale);
            if (!auditResult) {
                this.logger.warn('[JournalingPipeline] Failed to perform valence audit.');
                return null;
            }
            this.logger.log(`[JournalingPipeline] Audit result: valence=${auditResult.valence}, delta=${auditResult.suggested_score_delta}`);

            if (auditResult.valence === 'neutral' || auditResult.suggested_score_delta === 0) {
                this.logger.log('[JournalingPipeline] Audit resulted in neutral valence. No update generated.');
                return null;
            }

            // Step 3: Construct the update object for ontology_delta.json
            const update = {
                axis_id: axis.id,
                delta_score: auditResult.suggested_score_delta,
                // A static confidence increase for successful updates.
                // A more complex model could vary this based on audit confidence.
                delta_confidence: 0.01,
                evidence: evidence.substring(0, 280) + (evidence.length > 280 ? '...' : ''),
                rationale: rationale,
                auditor_reasoning: auditResult.reasoning,
                timestamp: new Date().toISOString(),
            };

            return update;

        } catch (error) {
            this.logger.error(`[JournalingPipeline] Error processing evidence for axis ${axis.id}:`, error);
            return null;
        }
    }

    /**
     * Calls the LLM to generate a rationale for an update.
     * @private
     * @param {object} axis
     * @param {string} evidence
     * @returns {Promise<string|null>} The generated rationale.
     */
    async generateRationale(axis, evidence) {
        const prompt = this.rationalePrompt
            .replace('{{axis.label}}', axis.label)
            .replace('{{axis.left_pole}}', axis.left_pole)
            .replace('{{axis.right_pole}}', axis.right_pole)
            .replace('{{axis.score}}', axis.score.toFixed(4))
            .replace('{{evidence}}', evidence);

        try {
            const response = await this.llm.call(prompt);
            const result = JSON.parse(response);
            return result.rationale || null;
        } catch (error) {
            this.logger.error('[JournalingPipeline] Failed to parse rationale from LLM response.', { response, error: error.message });
            return null;
        }
    }

    /**
     * Calls the LLM to audit the rationale and determine valence.
     * @private
     * @param {object} axis
     * @param {string} evidence
     * @param {string} rationale
     * @returns {Promise<object|null>} The audit result object.
     */
    async performValenceAudit(axis, evidence, rationale) {
        const prompt = this.auditorPrompt
            .replace('{{axis.label}}', axis.label)
            .replace('{{axis.left_pole}}', axis.left_pole)
            .replace('{{axis.right_pole}}', axis.right_pole)
            .replace('{{axis.score}}', axis.score.toFixed(4))
            .replace('{{evidence}}', evidence)
            .replace('{{rationale}}', rationale);

        try {
            const response = await this.llm.call(prompt);
            const result = JSON.parse(response);

            // Basic validation of the LLM's output structure
            if (!result.valence || !result.reasoning || typeof result.suggested_score_delta !== 'number') {
                throw new Error('Invalid audit JSON structure from LLM.');
            }
            
            // Clamp the delta to the daily cap to prevent runaway values
            const dailyCap = 0.05;
            result.suggested_score_delta = Math.max(-dailyCap, Math.min(dailyCap, result.suggested_score_delta));

            return result;
        } catch (error) {
            this.logger.error('[JournalingPipeline] Failed to parse audit result from LLM response.', { response, error: error.message });
            return null;
        }
    }
}

module.exports = JournalingPipeline;
