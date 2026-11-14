/**
 * Configuration: defaults from spec §17 plus a synchronous standard-schema
 * validator. cordis calls Config['~standard'].validate at load, so a plain
 * object or an async validator would make the bundle fail to load.
 */

export const DEFAULTS = Object.freeze({
	/** Automatic finalize at step pressure and on model switches. */
	auto: true,
	/** Background card generation while the main line keeps working. */
	background: true,
	/** Uncovered tokens that trigger a background card at the next legal boundary. */
	cardMinSourceTokens: 8000,
	/** Preferred upper bound of one card's source span; one indivisible step may exceed it. */
	cardMaxSourceTokens: 24000,
	/** Minimum gap between two background card requests of one session. */
	backgroundMinIntervalMs: 15000,
	/** Requests this plugin may have in flight per provider; unknown quota means 1. */
	providerConcurrency: 1,
	/** Finalize when the request reaches this fraction of the window (or the hard limit first). */
	finalizeSoftRatio: 0.65,
	/** The committed context must fit under this fraction of the window. */
	postCompactTargetRatio: 0.4,
	/** Room kept for what one more step can add: tool results and admitted input. */
	nextStepReserveTokens: 16384,
	/** Token estimation error buffer, as a fraction of the window. */
	estimateBufferRatio: 0.05,
	cardTextBudget: 1024,
	tailTextBudget: 2048,
	overviewTextBudget: 1536,
	/** Output caps per request; they include reasoning on providers that count it. */
	cardMaxOutputTokens: 4096,
	finalMaxOutputTokens: 8192,
	/** How long finalize waits for a running background card. */
	candidateWaitMs: 2000,
	/**
	 * Per-attempt limits. A request is abandoned when no chunk arrives for
	 * attemptIdleTimeoutMs (covers prompt prefill on slow local providers), or
	 * when the attempt exceeds its total cap.
	 */
	attemptIdleTimeoutMs: 180000,
	backgroundAttemptTimeoutMs: 600000,
	finalAttemptTimeoutMs: 900000,
	/** First attempt plus at most one retry. */
	maxAttemptsPerRequest: 2,
	/** Archive-merge rounds before giving up on a bundle. */
	maxFinalBundleAttempts: 2,
	/** Background input+output tokens per session; 0 means no background work. */
	backgroundTokenBudget: 2000000,
	/** Wait after a timed-out request before its quota slot is reused. */
	quarantineMs: 30000,
})

const BOOLEAN_KEYS = new Set(['auto', 'background'])
const RATIO_KEYS = new Set(['finalizeSoftRatio', 'postCompactTargetRatio', 'estimateBufferRatio'])
const POSITIVE_KEYS = new Set([
	'cardMinSourceTokens', 'cardMaxSourceTokens', 'providerConcurrency', 'cardTextBudget',
	'tailTextBudget', 'overviewTextBudget', 'cardMaxOutputTokens', 'finalMaxOutputTokens',
	'attemptIdleTimeoutMs', 'backgroundAttemptTimeoutMs', 'finalAttemptTimeoutMs', 'maxAttemptsPerRequest', 'maxFinalBundleAttempts',
])
const NON_NEGATIVE_KEYS = new Set([
	'backgroundMinIntervalMs', 'nextStepReserveTokens', 'candidateWaitMs', 'backgroundTokenBudget', 'quarantineMs',
])

/**
 * Validate an untrusted config and fill defaults.
 * @param {unknown} input - patch config; undefined and {} mean "all defaults".
 * @returns {{ value?: object, issues?: { message: string, path?: string[] }[] }}
 */
export function validateConfig(input) {
	if (input === undefined || input === null) return { value: { ...DEFAULTS } }
	if (typeof input !== 'object' || Array.isArray(input)) return { issues: [{ message: 'config must be an object' }] }
	const issues = []
	const value = { ...DEFAULTS }
	for (const [key, raw] of Object.entries(input)) {
		const path = [key]
		if (!(key in DEFAULTS)) {
			issues.push({ message: `unknown key "${key}"`, path })
		} else if (BOOLEAN_KEYS.has(key)) {
			if (typeof raw !== 'boolean') issues.push({ message: `${key} must be a boolean`, path })
			else value[key] = raw
		} else if (RATIO_KEYS.has(key)) {
			if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw >= 1) issues.push({ message: `${key} must be a number in (0, 1)`, path })
			else value[key] = raw
		} else if (POSITIVE_KEYS.has(key)) {
			if (!Number.isInteger(raw) || raw <= 0) issues.push({ message: `${key} must be a positive integer`, path })
			else value[key] = raw
		} else if (NON_NEGATIVE_KEYS.has(key)) {
			if (!Number.isInteger(raw) || raw < 0) issues.push({ message: `${key} must be a non-negative integer`, path })
			else value[key] = raw
		}
	}
	if (issues.length === 0) {
		if (value.cardMaxSourceTokens < value.cardMinSourceTokens) issues.push({ message: 'cardMaxSourceTokens must be >= cardMinSourceTokens' })
		if (value.postCompactTargetRatio >= value.finalizeSoftRatio) issues.push({ message: 'postCompactTargetRatio must be less than finalizeSoftRatio' })
	}
	return issues.length > 0 ? { issues } : { value: Object.freeze(value) }
}

/** Standard-schema object that cordis validates the patch config with. */
export const Config = Object.freeze({
	'~standard': Object.freeze({
		version: 1,
		vendor: 'dsh-cards-compaction',
		validate: validateConfig,
	}),
})

/**
 * Resolve config or throw, for code paths that receive raw config.
 * @param {unknown} input
 */
export function resolveConfig(input) {
	const result = validateConfig(input)
	if (result.issues) throw new Error(`dsh-cards-compaction config: ${result.issues.map((issue) => issue.message).join('; ')}`)
	return result.value
}

/**
 * Token limits for one routed model (spec §5).
 *
 * Finalize must start while both hold for the request C:
 *   C + mainReserve <= window
 *   C + mainReserve + nextStep + finalInstruction + finalOutput + buffer <= window
 * The main output reserve and the final output reserve add up rather than
 * taking the max: this step's output becomes the final request's input.
 * @returns {{ finalizeAt: number, target: number, window: number } | { infeasible: string }}
 */
export function pressureLimits(config, { contextWindow, mainReserve, finalInstructionTokens }) {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) return { infeasible: `unknown context window (${contextWindow})` }
	const reserve = Math.max(0, mainReserve ?? 0)
	const buffer = Math.ceil(contextWindow * config.estimateBufferRatio)
	const hard = contextWindow - reserve - config.nextStepReserveTokens - finalInstructionTokens - config.finalMaxOutputTokens - buffer
	const soft = Math.floor(contextWindow * config.finalizeSoftRatio)
	const finalizeAt = Math.min(soft, hard)
	// The latest point where the final request itself still fits the window;
	// a BLOCKED session still tries once more here rather than overflow.
	const lastResortAt = Math.max(finalizeAt, contextWindow - finalInstructionTokens - config.finalMaxOutputTokens - buffer)
	const target = Math.floor(contextWindow * config.postCompactTargetRatio)
	if (finalizeAt <= 0) return { infeasible: `context window ${contextWindow} leaves no room after reserving ${reserve} output, ${config.nextStepReserveTokens} next-step and ${config.finalMaxOutputTokens} final-summary tokens` }
	if (target >= finalizeAt) return { finalizeAt, lastResortAt, target: Math.floor(finalizeAt * 0.6), window: contextWindow }
	return { finalizeAt, lastResortAt, target, window: contextWindow }
}
