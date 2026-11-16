/**
 * Cards compaction engine (`ctx.compaction`).
 *
 * Background: while the main line works, condense uncovered history into
 * READY cards without touching the main context (spec §4A).
 * Finalize: between model requests, read the full main context once, write
 * the tail card and the overview, verify coverage and budget, and replace the
 * whole span in one checkpoint inside the host's log-recorded lock (§4B).
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { cardId, coverageProblem, lineageProblem, renderCheckpoint } from './checkpoint.js'
import { finalOutputCap, pressureLimits, resolveConfig } from './config.js'
import { GenerationError, retryable, streamText } from './generate.js'
import { host } from './host.js'
import { QuotaLimiter } from './limiter.js'
import { archiveInstruction, cardInstruction, finalInstruction, parseFinalOutput } from './prompts.js'
import * as S from './surface.js'
import { createReadHistoryTool, READ_HISTORY } from './tools.js'
import { processStore } from './store.js'
import { COMMAND, renderStatus } from './status.js'


/** The surface changed under a prepared bundle; it must not be committed. */
export class SurfaceChangedError extends Error {
	constructor(message, options) {
		super(message, options)
		this.name = 'SurfaceChangedError'
	}
}

/**
 * A finalize failure after compaction/start, with the stage it failed in:
 * `summary` left the surface untouched; `commit` may have replaced history.
 */
export class FinalizeError extends Error {
	constructor(stage, cause) {
		super(cause instanceof Error ? cause.message : String(cause), { cause })
		this.name = 'FinalizeError'
		this.stage = stage
		if (cause?.code !== undefined) this.code = cause.code
	}
}

/** Process-wide limiter: every session in this process shares provider quota. */
let processLimiter
function sharedLimiter(config) {
	processLimiter ??= new QuotaLimiter({ capacity: config.providerConcurrency, quarantineMs: config.quarantineMs })
	// A profile reload rebuilds the engine with new config; the shared limiter
	// keeps its in-flight and quarantined slots but takes the new limits.
	processLimiter.configure({ capacity: config.providerConcurrency, quarantineMs: config.quarantineMs })
	return processLimiter
}

// Awaited sleeps keep the event loop alive: with an unref timer, Node 22 can
// end the loop while a test or command still awaits it.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Per-attempt deadline. Unlike AbortSignal.timeout, its timer keeps the event
 * loop alive while a request waits on it; `clear()` drops it afterwards.
 */
function attemptDeadline(totalMs, idleMs) {
	const controller = new AbortController()
	const fire = (message) => controller.abort(new DOMException(message, 'TimeoutError'))
	const total = setTimeout(() => fire(`attempt exceeded its ${Math.round(totalMs / 1000)}s cap`), totalMs)
	let idle = setTimeout(() => fire(`no output for ${Math.round(idleMs / 1000)}s`), idleMs)
	return {
		signal: controller.signal,
		/** Restart the idle window; called for every streamed chunk. */
		touch() {
			if (controller.signal.aborted) return
			clearTimeout(idle)
			idle = setTimeout(() => fire(`no output for ${Math.round(idleMs / 1000)}s`), idleMs)
		},
		clear() {
			clearTimeout(total)
			clearTimeout(idle)
		},
	}
}

/** Name a deadline abort as a timeout instead of the generic "Request was aborted". */
function timeoutError(kind, signal, cause) {
	const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason)
	return new GenerationError(`${kind} request timed out: ${reason} (attemptIdleTimeoutMs / ${kind === 'background' ? 'backgroundAttemptTimeoutMs' : 'finalAttemptTimeoutMs'})`, 'TIMEOUT', { cause })
}

/** Sleep that rejects with the signal's reason when it aborts. */
function abortableDelay(ms, signal) {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted()
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal.reason)
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort)
			resolve()
		}, ms)
		signal?.addEventListener('abort', onAbort, { once: true })
	})
}
const sum = (items, pick) => items.reduce((total, item) => total + pick(item), 0)

/** Provider/model durably routed for the latest request. */
function routedTarget(session) {
	const config = session.requestHeader()?.config
	if (!config?.provider || !config?.model) return undefined
	return { provider: config.provider, model: config.model }
}

/** Input+output tokens from provider usage, or undefined when unknown. */
function usageTokens(usage) {
	if (!usage || typeof usage !== 'object') return undefined
	const input = usage.inputTokens ?? usage.input ?? usage.promptTokens
	const output = usage.outputTokens ?? usage.output ?? usage.completionTokens
	if (typeof input !== 'number' && typeof output !== 'number') return undefined
	return (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0)
}

/**
 * Latest open turn, latest unmatched compaction start, and latest seed
 * boundary, read from the log tail (same rule as the host's basic backend).
 */
export function inspectEntryState(session) {
	let openTurn = null
	let turnKnown = false
	let unmatchedStart
	let compactionKnown = false
	let latestEndSeed
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq)
		if (latestEndSeed === undefined && event.type === 'session/end-seed') latestEndSeed = event.seq
		if (!compactionKnown) {
			if (event.type === 'compaction/start') {
				unmatchedStart = event
				compactionKnown = true
			} else if (event.type === 'compaction/end') compactionKnown = true
		}
		if (!turnKnown) {
			if (event.type === 'turn/start') {
				openTurn = event.data.turn
				turnKnown = true
			} else if (event.type === 'turn/end') turnKnown = true
		}
		if (turnKnown && compactionKnown && latestEndSeed !== undefined) break
	}
	const active = unmatchedStart !== undefined && !(latestEndSeed !== undefined && latestEndSeed > unmatchedStart.seq)
	return { openTurn, active }
}

/**
 * All engine behavior, as a plain class so tests can build it with stand-in
 * services. CardsCompactionEngine below is the cordis Service that owns one.
 */
export class CardsCompactor {
	/**
	 * @param {object} ctx
	 * @param {object} [config]
	 * @param {{ limiter?: QuotaLimiter, now?: () => number, generate?: Function, service?: object }} [deps] - test seams;
	 *   `service` is the CompactionEngine that owns this compactor.
	 */
	constructor(ctx, config, deps = {}) {
		this.ctx = ctx
		this.service = deps.service
		this.store = deps.store ?? processStore
		this.config = resolveConfig(config)
		this.limiter = deps.limiter ?? sharedLimiter(this.config)
		this.now = deps.now ?? Date.now
		if (deps.generate) this.generateOnce = deps.generate
		/** @type {WeakMap<object, SessionState>} */
		this.states = new WeakMap()
		/** Main-line requests in flight per provider scope. */
		this.inference = new Map()
		this.inferenceScope = new WeakMap()
		/** Background jobs in flight per provider scope. */
		this.backgroundJobs = new Map()
		this.warned = new Set()
		this.disposed = false

		this.registerReadHistory()
		this.attachStore()
		this.registerCommand()
		this.registerTracking()
		if (this.config.auto) this.registerAutomatic()
		if (this.config.background) this.registerBackground()
		ctx.effect?.(() => () => this.dispose(), 'cards-compaction background jobs')
	}

	/**
	 * Register read_history once per tools layer. An agent preset that mounts
	 * this plugin in its isolated `compaction` group shares the root tools
	 * layer with the bundle's root row; the tool reads `exec.agent.session`,
	 * so one registration serves both, and a duplicate must not fail the mount.
	 */
	registerReadHistory() {
		try {
			this.ctx.tools?.register?.(createReadHistoryTool())
		} catch (error) {
			if (!/already registered/.test(error instanceof Error ? error.message : String(error))) throw error
			this.log('debug', `${READ_HISTORY} already registered by another instance; reusing it`)
		}
	}

	/**
	 * Register `/cards` once, like read_history. The handler resolves the
	 * compactor that owns the calling agent, so either instance serves it.
	 */
	registerCommand() {
		const register = (commands) => {
			try {
				return commands.register({
					name: COMMAND,
					description: "Show this session's history cards and compaction status (not sent to the model).",
					handler: async ({ agent, signal }) => {
						// The owning instance answers; a foreign service (compaction-basic) has
						// no compactor, so this one reports that it is inactive.
						const candidate = this.service === undefined ? undefined : this.visibleService(agent)?.compactor
						const owner = typeof candidate?.describe === 'function' ? candidate : this
						return { kind: 'success', text: await owner.describe(agent, signal) }
					},
				})
			} catch (error) {
				if (!/already registered/.test(error instanceof Error ? error.message : String(error))) throw error
				return undefined
			}
		}
		if (typeof this.ctx.inject === 'function') {
			this.ctx.inject(['commands'], (inner) => {
				inner.effect(() => register(inner.commands) ?? (() => {}), 'cards-compaction /cards')
			})
		} else if (this.ctx.commands) {
			register(this.ctx.commands)
		}
	}

	/** Status text for `/cards`. */
	async describe(agent, signal) {
		if (!this.owns(agent)) return renderStatus({ owner: 'foreign' })
		const session = agent.session
		const state = this.state(session)
		const header = session.requestHeader()
		let context
		if (header?.config?.provider && header?.config?.model) {
			try {
				const limits = await this.limitsFor(header, signal)
				const total = this.ctx.tokenMeter.measure(session, header).totalTokens
				context = limits.infeasible ? { total, infeasible: limits.infeasible } : { total, ...limits }
			} catch (error) {
				context = { total: 0, infeasible: `limits unavailable: ${error instanceof Error ? error.message : String(error)}` }
			}
		}
		const status = {
			state: state.finalizing ? 'compacting' : state.blocked ? 'BLOCKED (automatic compaction paused; /compact retries)' : state.job ? 'writing a background card' : 'idle',
			failures: state.failures,
			...(state.lastError === undefined ? {} : { lastError: state.lastError, lastErrorAt: state.lastErrorAt }),
		}
		const cards = [...state.cards.values()]
			.sort((a, b) => a.seqs[0] - b.seqs[0])
			.map((card) => ({ id: card.id, seqs: card.seqs, body: card.body, valid: this.spanStillValid(session, card.seqs, card.digest) }))
		return renderStatus({
			owner: 'owned',
			status,
			context,
			cards,
			background: { used: state.backgroundTokens, budget: this.config.backgroundTokenBudget },
			now: this.now(),
		})
	}

	// --- logging ---------------------------------------------------------------

	log(level, message) {
		this.ctx.logger?.[level]?.(`cards-compaction: ${message}`)
	}

	warnOnce(key, message) {
		if (this.warned.has(key)) return
		this.warned.add(key)
		this.log('warn', message)
	}

	dispose() {
		this.disposed = true
		for (const jobs of this.backgroundJobs.values()) for (const job of jobs) job.abort.abort(new Error('cards-compaction disposed'))
	}

	// --- per-session state -----------------------------------------------------

	/**
	 * @typedef {{ cards: Map<string, object>, job?: object, lastBackgroundAt: number, backgroundTokens: number,
	 *   finalizing: boolean, failures: number, retryAfterTokens: number, blocked: boolean }} SessionState
	 */
	state(session) {
		let state = this.states.get(session)
		if (!state) {
			state = { cards: new Map(), job: undefined, lastBackgroundAt: -Infinity, backgroundTokens: 0, finalizing: false, failures: 0, retryAfterTokens: 0, blocked: false, idle: true, owned: undefined, retryTimer: undefined }
			this.states.set(session, state)
			this.loadStored(session, state)
			// The domain may still be opening on the first sessions after startup.
			this.store.ready().then(() => this.loadStored(session, state), () => {})
		}
		return state
	}

	/** Rebuild READY candidates stored before a restart; each is re-validated before use. */
	loadStored(session, state) {
		for (const card of this.store.load(session.id)) {
			// A card whose source was replaced (adopted by a checkpoint) is not reloaded.
			if (!this.cardValid(session, card)) continue
			if (!state.cards.has(card.id)) state.cards.set(card.id, { id: card.id, seqs: card.seqs, depth: 0, body: card.body, digest: card.digest })
		}
	}

	cardValid(session, card) {
		try {
			return this.spanStillValid(session, card.seqs, card.digest)
		} catch {
			return false
		}
	}

	/** Persist READY background cards; losing them only costs regeneration. */
	persist(session, state) {
		const cards = [...state.cards.values()].filter((card) => card.depth === 0 && typeof card.digest === 'string' && this.cardValid(session, card))
		this.store.save(session.id, cards, this.now()).catch((error) => {
			this.log('debug', `cards not persisted: ${error instanceof Error ? error.message : String(error)}`)
		})
	}

	/** Share the process card store; it opens over the host storage-domain service when present. */
	attachStore() {
		const attach = (facility) => {
			const release = this.store.acquire(facility, host.storageDomain, (message) => this.warnOnce('store', message))
			return () => release()
		}
		if (typeof this.ctx.inject === 'function') {
			this.ctx.inject(['storageDomain'], (inner) => {
				inner.effect(() => attach(inner.storageDomain), 'cards-compaction store')
			})
		}
	}

	// --- ownership --------------------------------------------------------------

	/**
	 * Whether this engine is the compaction service the agent actually uses.
	 * An agent preset may isolate its own `compaction` (dsh-web-app mounts
	 * compaction-basic inside every preset), and root listeners still receive
	 * that agent's events; acting then would make two compaction owners.
	 * `agent.ctx` cannot see a preset's isolated realm, so the preset registry's
	 * `serviceFor` is asked first, as the host itself does.
	 */
	owns(agent) {
		const state = this.state(agent.session)
		if (this.service === undefined) {
			state.owned = true
			return true
		}
		const visible = this.visibleService(agent)
		state.owned = visible === undefined || visible?.compactor === this
		if (!state.owned) {
			this.warnOnce('foreign-owner', 'another compaction service owns this agent (for example compaction-basic inside an agent preset); cards compaction stays inactive for it. See the README install section for presets.')
		}
		return state.owned
	}

	/** The compaction service this agent uses, or undefined when none can be resolved. */
	visibleService(agent) {
		try {
			const preset = this.ctx.get?.('agentPresets', false)?.serviceFor?.(agent, 'compaction')
			if (preset !== undefined) return preset
			return typeof agent.ctx?.get === 'function' ? agent.ctx.get('compaction', false) : undefined
		} catch {
			return undefined
		}
	}

	/** Background work runs only for sessions an owned agent has touched (always, without a service owner). */
	ownsSession(session) {
		if (this.service === undefined) return true
		return this.state(session).owned === true
	}

	// --- main-line tracking ----------------------------------------------------

	beginInference(session, scope) {
		if (!scope) return
		this.endInference(session)
		this.inference.set(scope, (this.inference.get(scope) ?? 0) + 1)
		this.inferenceScope.set(session, scope)
	}

	endInference(session) {
		const scope = this.inferenceScope.get(session)
		if (scope === undefined) return
		this.inferenceScope.delete(session)
		this.inference.set(scope, Math.max(0, (this.inference.get(scope) ?? 1) - 1))
	}

	/** With one slot per provider, the main line waits for our background requests to settle. */
	async yieldToMain(session) {
		if (this.config.providerConcurrency !== 1) return
		const scope = routedTarget(session)?.provider
		const jobs = scope === undefined ? undefined : this.backgroundJobs.get(scope)
		if (jobs && jobs.size > 0) await Promise.allSettled([...jobs].map((job) => job.promise))
	}

	registerTracking() {
		const { ctx } = this
		ctx.on('agent/request', async ({ agent, signal }, next) => {
			const config = await next()
			if (!this.owns(agent)) return config
			this.state(agent.session).idle = false
			const previous = agent.session.requestHeader()
			const switching = previous !== undefined && config.provider && config.model
				&& (previous.config.provider !== config.provider || previous.config.model !== config.model)
			if (this.config.auto && switching && !signal.aborted) {
				try {
					await this.yieldToMain(agent.session)
					const result = await this.pressure(agent, signal, 0, { ...previous, config })
					if (result) this.log('info', `model switch: replaced ${result.shadowedSeqs.length} surface nodes`)
				} catch (error) {
					signal.throwIfAborted()
					const message = error instanceof Error ? error.message : String(error)
					throw new host.LlmError(`Cannot switch to ${config.provider}/${config.model}: cards compaction failed: ${message}. The previous request model is preserved.`, 'MODEL_SWITCH_COMPACTION_FAILED', { cause: error })
				}
			}
			this.beginInference(agent.session, config.provider)
			return config
		}, { prepend: true })
		ctx.on('agent/request-error', async (input, next) => {
			this.endInference(input.agent.session)
			const { agent, failure, signal } = input
			if (failure?.code !== host.CONTEXT_WINDOW_EXCEEDED_CODE || signal?.aborted || !this.config.auto || !this.owns(agent)) return next()
			// One recovery per overflow streak; a reply from the model resets it.
			const state = this.state(agent.session)
			if (state.overflowRecovered) return next()
			state.overflowRecovered = true
			try {
				const result = await this.recoverOverflow(agent, signal)
				if (result) {
					this.log('info', `context overflow: replaced ${result.shadowedSeqs.length} surface nodes with ${result.cardCount} cards; retrying the request`)
					return { kind: 'retry' }
				}
			} catch (error) {
				if (signal?.aborted) throw error
				this.log('warn', `context overflow recovery failed: ${error instanceof Error ? error.message : String(error)}; the request error stands`)
			}
			return next()
		})
		ctx.on('agent/disposed', (input) => {
			const session = input?.agent?.session
			if (!session) return
			const state = this.states.get(session)
			if (!state) return
			state.closed = true
			clearTimeout(state.retryTimer)
			state.job?.abort.abort(new Error('agent disposed'))
		})
		ctx.on('agent/status', ({ agent, status }) => {
			if (status !== 'idle') return
			this.endInference(agent.session)
			// A failed recovery must not disable it for the rest of the session.
			const idleState = this.states.get(agent.session)
			if (idleState) idleState.overflowRecovered = false
			if (!this.owns(agent)) return
			this.state(agent.session).idle = true
			this.kick(agent.session)
		})
	}

	registerAutomatic() {
		this.ctx.on('agent/pre-step', async (input, next) => {
			const { agent, messages, signal } = input
			if (!signal.aborted && this.owns(agent)) {
				this.state(agent.session).idle = false
				try {
					await this.yieldToMain(agent.session)
					const extra = sum(messages ?? [], (message) => {
						try {
							return this.ctx.tokenMeter.estimateMessage(message)
						} catch {
							return 0
						}
					})
					const result = await this.pressure(agent, signal, extra)
					if (result) this.log('info', `step pressure: replaced ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens) with ${result.cardCount} cards`)
				} catch (error) {
					if (!signal.aborted) this.log('warn', `finalize failed: ${error instanceof Error ? error.message : String(error)}; continuing with the full context`)
				}
			}
			return next()
		})
	}

	registerBackground() {
		this.ctx.on('session/event', (session, event) => {
			if (event.type === 'assistant/message') {
				this.endInference(session)
				const state = this.states.get(session)
				if (state) state.overflowRecovered = false
			}
			if (event.type === 'assistant/message' || event.type === 'tool/result') this.kick(session)
		})
	}

	/** Check again after the minimum interval, at most one pending timer per session. */
	kickLater(session, state, ms) {
		if (state.retryTimer !== undefined || this.disposed) return
		state.retryTimer = setTimeout(() => {
			state.retryTimer = undefined
			this.kick(session)
		}, ms)
		state.retryTimer.unref?.()
	}

	/** Defer a background check until the current append has finished publishing. */
	kick(session) {
		if (!this.config.background || this.disposed) return
		setTimeout(() => {
			this.maybeStartBackground(session)?.catch(() => {})
		}, 0).unref?.()
	}

	// --- background cards ------------------------------------------------------

	/**
	 * Start one background card if the session has enough uncovered history
	 * and quota allows it.
	 * @returns {Promise<void> | undefined} the job, when one started.
	 */
	maybeStartBackground(session) {
		if (!this.config.background || this.disposed) return undefined
		const state = this.state(session)
		if (!this.ownsSession(session) || state.closed) return undefined
		if (state.job || state.finalizing || state.blocked) return undefined
		if (state.backgroundTokens >= this.config.backgroundTokenBudget) {
			if (this.config.backgroundTokenBudget > 0) this.warnOnce(`budget:${session.id}`, `session ${session.id} reached backgroundTokenBudget; background cards stop, finalize still runs`)
			return undefined
		}
		const wait = state.lastBackgroundAt + this.config.backgroundMinIntervalMs - this.now()
		if (wait > 0) {
			this.kickLater(session, state, wait)
			return undefined
		}
		const target = routedTarget(session)
		if (!target) return undefined
		// One slot per provider: a card started in a short tool gap would make the
		// next step wait for it, so background work waits for an idle agent.
		if (this.config.providerConcurrency === 1 && (!state.idle || (this.inference.get(target.provider) ?? 0) > 0)) return undefined
		let plan
		try {
			plan = this.planBackground(session, state)
		} catch (error) {
			this.log('debug', `background plan skipped: ${error.message}`)
			return undefined
		}
		if (!plan) return undefined
		const slot = this.limiter.tryAcquireBackground(target.provider)
		if (!slot) return undefined

		state.lastBackgroundAt = this.now()
		const job = { abort: new AbortController(), seqs: plan.seqs, discard: false, promise: undefined }
		let jobs = this.backgroundJobs.get(target.provider)
		if (!jobs) this.backgroundJobs.set(target.provider, jobs = new Set())
		jobs.add(job)
		state.job = job
		job.promise = this.runBackground(session, state, job, plan, target, slot).finally(() => {
			jobs.delete(job)
			if (state.job === job) state.job = undefined
			// More uncovered history may remain; check again once a card landed.
			// A failed card waits for the next session event instead of retrying
			// the same span on a timer.
			if (job.produced && !job.abort.signal.aborted) this.kick(session)
		})
		return job.promise
	}

	/** Choose the next uncovered segment and freeze its request snapshot. */
	planBackground(session, state) {
		const nodes = S.surfaceNodes(session)
		const measurement = this.ctx.tokenMeter.measure(session)
		this.assertAligned(nodes, measurement)
		const balanced = S.balancedAfter(session, nodes)
		const { start } = S.coverageStart(session, nodes)
		const frontier = this.frontier(session, state, nodes, start, nodes.length - 1)
		const segment = S.selectSegment(balanced, measurement.nodes, frontier.idx, {
			minTokens: this.config.cardMinSourceTokens,
			maxTokens: this.config.cardMaxSourceTokens,
		})
		if (!segment) return undefined
		const seqs = nodes.slice(segment.startIdx, segment.endIdx + 1)
		return {
			seqs,
			digest: S.spanDigest(session, seqs),
			span: S.spanDescriptor(session, seqs),
			prefix: this.snapshotPrefix(session, nodes, segment.endIdx),
			prefixTokens: sum(measurement.nodes.slice(0, segment.endIdx + 1), (node) => node.tokens),
		}
	}

	async runBackground(session, state, job, plan, target, slot) {
		const deadline = attemptDeadline(this.config.backgroundAttemptTimeoutMs, this.config.attemptIdleTimeoutMs)
		const timeout = deadline.signal
		const signal = AbortSignal.any([job.abort.signal, timeout])
		let abandoned = false
		try {
			const result = await this.generateOnce({
				session,
				target,
				prefix: plan.prefix,
				instruction: cardInstruction(plan.span, this.config.cardTextBudget),
				maxTokens: this.cardCap(state),
				kind: 'background card',
				signal,
				onProgress: deadline.touch,
			})
			state.backgroundTokens += usageTokens(result.usage) ?? plan.prefixTokens + this.cardCap(state)
			if (job.discard || job.abort.signal.aborted) return
			if (!this.spanStillValid(session, plan.seqs, plan.digest)) {
				this.log('debug', `background card for seqs ${plan.seqs[0]}-${plan.seqs.at(-1)} is stale; discarded`)
				return
			}
			const card = { id: cardId('c', plan.seqs), seqs: plan.seqs, depth: 0, body: result.text, digest: plan.digest }
			state.cards.set(card.id, card)
			job.produced = true
			this.persist(session, state)
		} catch (error) {
			abandoned = timeout.aborted
			state.backgroundTokens += plan.prefixTokens
			const failure = abandoned ? timeoutError('background', timeout, error) : error
			const truncated = error?.code === 'MAX_TOKENS'
			// The next card gets a doubled cap; the same cap would truncate again.
			if (truncated) this.raiseCardCap(state, this.cardCap(state) * 2)
			const note = truncated ? `; next card cap ${this.cardCap(state)}` : ''
			this.log(abandoned || truncated ? 'warn' : 'debug', `background card failed: ${failure instanceof Error ? failure.message : String(failure)}${note}`)
		} finally {
			deadline.clear()
			if (abandoned) slot.releaseAfterQuarantine()
			else slot.release()
		}
	}

	/** Whether seqs are still contiguous on the surface with unchanged content. */
	spanStillValid(session, seqs, digest) {
		const nodes = S.surfaceNodes(session)
		const at = nodes.indexOf(seqs[0])
		if (at === -1 || !isDeepStrictEqual(nodes.slice(at, at + seqs.length), seqs)) return false
		return S.spanDigest(session, seqs) === digest
	}

	/**
	 * Walk READY cards forward from `fromIdx` while each one matches the
	 * surface exactly (contiguous, unchanged). MVP accepts only a contiguous
	 * prefix chain; a gap stops the chain and the rest is redone.
	 */
	frontier(session, state, nodes, fromIdx, lastIdx) {
		const cards = []
		let idx = fromIdx
		while (idx <= lastIdx) {
			const card = [...state.cards.values()].find((candidate) => candidate.seqs[0] === nodes[idx])
			if (!card) break
			const end = idx + card.seqs.length - 1
			if (end > lastIdx || !isDeepStrictEqual(nodes.slice(idx, end + 1), card.seqs) || S.spanDigest(session, card.seqs) !== card.digest) break
			cards.push(card)
			idx = end + 1
		}
		return { idx, cards }
	}

	snapshotPrefix(session, nodes, endIdx) {
		return { ...S.requestPrefix(session, nodes, endIdx), toolHistory: session.toolHistory?.() }
	}

	assertAligned(nodes, measurement) {
		if (nodes.length !== measurement.nodes.length || nodes.some((seq, index) => measurement.nodes[index].seq !== seq)) {
			throw new SurfaceChangedError('token-meter surface does not match the session surface')
		}
	}

	// --- generation ------------------------------------------------------------

	/** One request: replayed prefix plus the trailing instruction. Test seam. */
	async generateOnce({ session, target, prefix, instruction, maxTokens, kind, signal, onProgress }) {
		const messages = [...prefix.messages, Object.freeze({ role: 'user', content: [Object.freeze({ type: 'text', text: instruction })] })]
		return streamText(this.ctx, {
			provider: target.provider,
			model: target.model,
			messages,
			...(prefix.tools === undefined ? {} : { tools: prefix.tools }),
			...(prefix.toolHistory === undefined ? {} : { toolHistory: prefix.toolHistory }),
			maxTokens,
			kind,
			sessionId: session.id,
			signal,
			onProgress,
		})
	}

	/**
	 * Foreground generation with a per-attempt timeout and bounded retries.
	 * Truncation at the output cap retries with the cap doubled (up to
	 * finalMaxOutputTokens and request.maxTokensCeiling) without using up an
	 * attempt; the same cap again would only truncate again. request.onCap
	 * learns a raised cap that worked.
	 */
	async generateForeground(run, request, accept = (text) => text) {
		let lastError
		let maxTokens = request.maxTokens
		const ceiling = Math.max(request.maxTokens, Math.min(
			this.config.finalMaxOutputTokens,
			request.maxTokensCeiling ?? Number.POSITIVE_INFINITY,
		))
		for (let attempt = 1; attempt <= this.config.maxAttemptsPerRequest; attempt += 1) {
			request.signal?.throwIfAborted()
			const deadline = attemptDeadline(this.config.finalAttemptTimeoutMs, this.config.attemptIdleTimeoutMs)
			const timeout = deadline.signal
			try {
				const result = await this.generateOnce({ ...request, maxTokens, signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout, onProgress: deadline.touch })
				const value = accept(result.text)
				if (maxTokens > request.maxTokens) request.onCap?.(maxTokens)
				return value
			} catch (error) {
				lastError = timeout.aborted && !request.signal?.aborted ? timeoutError('foreground', timeout, error) : error
				if (!retryable(error, request.signal)) throw lastError
				if (error?.code === 'MAX_TOKENS') {
					if (maxTokens >= ceiling) throw lastError
					maxTokens = Math.min(ceiling, maxTokens * 2)
					this.log('info', `${request.kind ?? 'output'} truncated; retrying with maxTokens ${maxTokens}`)
					attempt -= 1
					continue
				}
				if (timeout.aborted) {
					// Abandoning a request does not prove the server stopped it; wait out
					// the quarantine before sending another on the same slot (AC31).
					run.timedOut = true
					if (attempt < this.config.maxAttemptsPerRequest) await abortableDelay(this.config.quarantineMs, request.signal)
				}
			} finally {
				deadline.clear()
			}
		}
		throw lastError
	}

	/** Card output cap of a session: the default, raised after truncation. */
	cardCap(state) {
		return Math.max(this.config.cardMaxOutputTokens, state.cardCap ?? 0)
	}

	raiseCardCap(state, cap) {
		state.cardCap = Math.min(this.config.finalMaxOutputTokens, Math.max(this.cardCap(state), cap))
	}

	estimateText(text) {
		return this.ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
	}

	// --- pressure and finalize -------------------------------------------------

	/** Token limits for a request header, or { infeasible }. */
	async limitsFor(header, signal) {
		const { provider, model } = header.config
		const info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
		const finalInstructionTokens = this.estimateText(finalInstruction({ count: 1, firstRole: 'user', firstExcerpt: 'x'.repeat(120) }, this.config)) + 64
		return pressureLimits(this.config, {
			contextWindow: info?.context?.contextWindow,
			mainReserve: header.config.maxTokens ?? info?.defaultMaxTokens ?? 0,
			finalInstructionTokens,
		})
	}

	/**
	 * Finalize when the request is at or past the safe limit (spec §5).
	 * @param {number} extraTokens - input claimed for this step but not yet in the log.
	 * @param {object} [header] - proposed header (model switch); defaults to the latest.
	 */
	async pressure(agent, signal, extraTokens, header) {
		const session = agent.session
		const state = this.state(session)
		const effective = header ?? session.requestHeader()
		if (!effective?.config?.provider || !effective?.config?.model) return null
		const limits = await this.limitsFor(effective, signal)
		if (limits.infeasible) {
			this.warnOnce(`limits:${effective.config.provider}/${effective.config.model}`, `auto finalize disabled for ${effective.config.provider}/${effective.config.model}: ${limits.infeasible}`)
			return null
		}
		const total = this.ctx.tokenMeter.measure(session, effective).totalTokens + extraTokens
		if (total < limits.finalizeAt) return null
		// BLOCKED stops automatic attempts, except a last one where the final
		// request can still fit: overflowing the window is worse than retrying.
		const lastResort = state.blocked && total >= limits.lastResortAt
		if ((state.blocked && !lastResort) || (state.retryAfterTokens > 0 && total < state.retryAfterTokens)) return null
		if (lastResort) this.log('warn', `session ${session.id} is BLOCKED but near the context limit (${total} tokens); trying once more`)
		try {
			const result = await this.finalize(agent, { owner: 'current-turn', stability: 'whole-surface', signal, limits })
			state.failures = 0
			state.retryAfterTokens = 0
			state.blocked = false
			return result
		} catch (error) {
			if (signal?.aborted || error?.code === 'busy') throw error
			state.failures += 1
			state.lastError = error instanceof Error ? error.message : String(error)
			state.lastErrorAt = this.now()
			state.retryAfterTokens = total + this.config.cardMinSourceTokens
			if (state.failures >= this.config.maxFinalBundleAttempts) {
				state.blocked = true
				this.log('warn', `session ${session.id} BLOCKED: finalize failed ${state.failures} times; automatic compaction stops until /compact succeeds`)
			}
			throw error
		}
	}

	/**
	 * Run one finalize transaction.
	 * @param {object} agent
	 * @param {{ owner: 'current-turn' | null, stability: 'whole-surface' | 'selected-span', signal?: AbortSignal,
	 *   limits?: { target: number }, sourceCommandId?: string, flush?: boolean, region?: { start: number, end: number } }} options
	 * @returns {Promise<object | null>} the compaction result, or null when nothing can be compacted.
	 */
	async finalize(agent, options) {
		const session = agent.session
		const state = this.state(session)
		const plan = this.planFinalize(agent, options)
		if (!plan) return null

		const entry = inspectEntryState(session)
		if (entry.active) throw new host.ManualCompactionError('busy', 'compaction already in progress; the session compaction lock is active')
		if (options.owner === null && entry.openTurn !== null) throw new host.ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
		if (options.owner !== null && entry.openTurn === null) throw new Error('automatic compaction needs an open turn')

		const compactionId = randomUUID()
		const lifecycle = { compactionId, ...(options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId }), turn: options.owner === null ? null : entry.openTurn }
		state.finalizing = true
		const startEvent = session.append('compaction/start', lifecycle)
		let failure
		let result
		let closed = false
		let stage = 'summary'
		try {
			const bundle = await this.buildBundle(session, state, plan, compactionId, options)
			options.signal?.throwIfAborted()
			this.assertStable(session, plan, options.stability)
			stage = 'commit'
			result = this.commit(session, startEvent, plan, bundle)
			closed = true
			result.endSeq = session.append('compaction/end', lifecycle).seq
			for (const card of bundle.adopted) state.cards.delete(card.id)
			// Adopted cards now live in the checkpoint; drop them from the store too,
			// so /cards after a restart does not list them as stale.
			this.persist(session, state)
			state.blocked = false
			state.failures = 0
		} catch (error) {
			failure = error
			if (!closed && !result) {
				try {
					session.append('compaction/end', { ...lifecycle, error: host.errorChain(error) })
				} catch (closeError) {
					failure = closeError
				}
			}
		} finally {
			state.finalizing = false
		}
		if (failure) throw new FinalizeError(stage, failure)
		if (options.flush) {
			try {
				await this.ctx.sessions.flush(session)
			} catch (error) {
				throw new host.ManualCompactionError('persistence', 'cards compaction durability checkpoint failed', { cause: error })
			}
		}
		return result
	}

	/** Synchronous snapshot of what finalize will replace. */
	planFinalize(agent, options) {
		const session = agent.session
		const target = routedTarget(session)
			?? (agent.options?.provider && agent.options?.model ? { provider: agent.options.provider, model: agent.options.model } : undefined)
		if (!target) throw new Error('no provider/model to summarize with: route one request first')
		const nodes = S.surfaceNodes(session)
		const measurement = this.ctx.tokenMeter.measure(session)
		this.assertAligned(nodes, measurement)
		const balanced = S.balancedAfter(session, nodes)

		let first
		let lastIdx
		if (options.region) {
			first = nodes.indexOf(options.region.start)
			lastIdx = nodes.indexOf(options.region.end)
			if (first === -1 || lastIdx === -1 || first > lastIdx) throw new Error(`region ${options.region.start}-${options.region.end} is not an ordered surface span`)
			if (first > 0 && !balanced[first - 1]) throw new Error(`region start ${options.region.start} would split a tool call from its result`)
		} else {
			first = S.firstCompactableIndex(session, nodes)
			lastIdx = nodes.length - 1
		}
		if (lastIdx < first) return null
		if (!balanced[lastIdx]) throw new Error('the span ends inside an unanswered tool call')
		const prior = S.checkpointAt(session, nodes[first])
		const startIdx = prior ? first + 1 : first
		// Only a prior checkpoint and nothing new: replacing it gains nothing.
		if (startIdx > lastIdx) return null

		const regionSeqs = nodes.slice(first, lastIdx + 1)
		return {
			target,
			nodes,
			measurement,
			balanced,
			first,
			startIdx,
			lastIdx,
			prior,
			regionSeqs,
			regionDigest: S.spanDigest(session, regionSeqs),
			regionTokens: sum(measurement.nodes.slice(first, lastIdx + 1), (node) => node.tokens),
			shadowedTokenCount: sum(measurement.nodes.slice(first, lastIdx + 1), (node) => node.heuristicTokens ?? node.tokens),
		}
	}

	/** Adopt READY cards, catch up oversized tails, run the final request, fit the budget. */
	async buildBundle(session, state, plan, compactionId, options) {
		const { nodes, measurement, balanced, startIdx, lastIdx, target } = plan
		const signal = options.signal

		// A running background card gets a short grace period; after that its
		// result is not adopted, so the set of cards is fixed from here on.
		if (state.job) {
			await Promise.race([state.job.promise, delay(this.config.candidateWaitMs)])
			if (state.job) state.job.discard = true
		}
		const frontier = this.frontier(session, state, nodes, startIdx, lastIdx)
		const adopted = [...frontier.cards]
		let idx = frontier.idx

		const run = { timedOut: false }
		// Output room left in the window for any request here (all inputs are
		// at most the whole context); bounds the cap growth on truncation.
		const window = options.limits?.window
		const inputTokens = measurement.totalTokens - sum(measurement.nodes.slice(lastIdx + 1), (node) => node.tokens)
		const room = window === undefined ? undefined
			: Math.max(0, window - inputTokens - Math.ceil(window * this.config.estimateBufferRatio) - 2048)
		const finalCap = finalOutputCap(this.config, window)
		const cardCeiling = room === undefined ? finalCap : Math.min(room, finalCap)
		const slot = await this.limiter.acquireForeground(target.provider, signal)
		try {
			// Tail too large for one final card: add cards first, never cut it.
			while (sum(measurement.nodes.slice(idx, lastIdx + 1), (node) => node.tokens) > this.config.cardMaxSourceTokens) {
				const segment = S.selectSegment(balanced, measurement.nodes, idx, { minTokens: this.config.cardMinSourceTokens, maxTokens: this.config.cardMaxSourceTokens })
				if (!segment || segment.endIdx >= lastIdx) break
				const seqs = nodes.slice(segment.startIdx, segment.endIdx + 1)
				const body = await this.generateForeground(run, {
					session,
					target,
					prefix: this.snapshotPrefix(session, nodes, segment.endIdx),
					instruction: cardInstruction(S.spanDescriptor(session, seqs), this.config.cardTextBudget),
					maxTokens: Math.max(this.config.cardMaxOutputTokens, Math.min(this.cardCap(state), cardCeiling)),
					maxTokensCeiling: cardCeiling,
					kind: 'tail card',
					onCap: (cap) => this.raiseCardCap(state, cap),
					signal,
				})
				adopted.push({ id: cardId('c', seqs), seqs, depth: 0, body })
				idx = segment.endIdx + 1
			}

			const tailSeqs = nodes.slice(idx, lastIdx + 1)
			const prefix = this.snapshotPrefix(session, nodes, lastIdx)
			const finalTokens = room === undefined ? finalCap : Math.max(this.config.cardMaxOutputTokens, Math.min(finalCap, room))
			const { tailCard, overview } = await this.generateForeground(run, {
				session,
				target,
				prefix,
				instruction: finalInstruction(S.spanDescriptor(session, tailSeqs), this.config),
				maxTokens: finalTokens,
				// The final cap is already as large as fits; doubling cannot help.
				maxTokensCeiling: finalTokens,
				kind: 'final',
				signal,
			}, (text) => parseFinalOutput(text, tailSeqs.length > 0))

			const fresh = tailSeqs.length > 0 ? [...adopted, { id: cardId('c', tailSeqs), seqs: tailSeqs, depth: 0, body: tailCard }] : adopted
			const gap = coverageProblem(fresh, nodes.slice(startIdx, lastIdx + 1))
			if (gap) throw new Error(`invalid coverage: ${gap}`)
			let cards = [...(plan.prior?.cards ?? []), ...fresh]
			const problem = lineageProblem(cards)
			if (problem) throw new Error(`invalid card lineage: ${problem}`)

			const fixedTokens = measurement.totalTokens - plan.regionTokens
			const target_ = options.limits?.target
			for (let round = 0; ; round += 1) {
				const message = this.checkpointMessage(cards, overview, compactionId, options.sourceCommandId)
				const framed = this.ctx.tokenMeter.estimateMessage(message)
				const fits = target_ === undefined || fixedTokens + framed <= target_
				if (fits && framed < plan.regionTokens) return { message, cards, overview, adopted: frontier.cards, framed }
				if (round >= this.config.maxFinalBundleAttempts) {
					throw new Error(framed >= plan.regionTokens
						? `checkpoint is not smaller than the span it replaces (${framed} >= ${plan.regionTokens} tokens)`
						: `checkpoint does not fit the post-compact target (${fixedTokens + framed} > ${target_} tokens)`)
				}
				const merged = await this.mergeOldest(run, session, target, prefix, cards, signal, { room, cap: finalCap }, state)
				if (!merged) throw new Error(`cards exceed the budget and cannot be merged further (${fixedTokens + framed} tokens)`)
				cards = merged
			}
		} finally {
			if (run.timedOut) slot.releaseAfterQuarantine()
			else slot.release()
		}
	}

	/**
	 * Merge the oldest cards into one archive card (spec §15). Returns
	 * undefined when nothing can shrink.
	 */
	async mergeOldest(run, session, target, prefix, cards, signal, { room, cap } = {}, state) {
		if (cards.length === 0) return undefined
		if (cards.length === 1 && cards[0].depth === 0) return undefined
		const count = cards.length === 1 ? 1 : Math.max(2, Math.ceil(cards.length / 2))
		const group = cards.slice(0, count)
		const instruction = archiveInstruction(group, this.config.cardTextBudget * 2)
		// The instruction quotes the group's bodies on top of the prefix.
		const fits = room === undefined ? Number.POSITIVE_INFINITY : Math.max(0, room + 2048 - this.estimateText(instruction))
		const ceiling = Math.min(cap ?? this.config.finalMaxOutputTokens, fits)
		const body = await this.generateForeground(run, {
			session,
			target,
			prefix,
			instruction,
			maxTokens: Math.max(this.config.cardMaxOutputTokens, Math.min(state ? this.cardCap(state) : 0, ceiling)),
			maxTokensCeiling: ceiling,
			kind: 'archive card',
			...(state ? { onCap: (cap) => this.raiseCardCap(state, cap) } : {}),
			signal,
		})
		if (this.estimateText(body) >= sum(group, (card) => this.estimateText(card.body))) return undefined
		const seqs = group.flatMap((card) => card.seqs).sort((a, b) => a - b)
		const archive = { id: cardId('a', seqs), seqs, depth: Math.max(...group.map((card) => card.depth)) + 1, body }
		return [archive, ...cards.slice(count)]
	}

	checkpointMessage(cards, overview, compactionId, sourceCommandId) {
		return host.createUserMessage({
			content: [{ type: 'text', text: renderCheckpoint({ cards, overview }) }],
			source: host.compactCheckpointSource(compactionId, sourceCommandId),
		})
	}

	/** Reject a bundle prepared against a surface that has since changed. */
	assertStable(session, plan, stability) {
		if (stability === 'whole-surface') {
			if (!isDeepStrictEqual(this.ctx.tokenMeter.measure(session).nodes, plan.measurement.nodes)) {
				throw new SurfaceChangedError('the session surface changed during finalize')
			}
			return
		}
		if (!this.spanStillValid(session, plan.regionSeqs, plan.regionDigest)) throw new SurfaceChangedError('the compacted span changed during finalize')
		const nodes = S.surfaceNodes(session)
		const endIdx = nodes.indexOf(plan.regionSeqs.at(-1))
		if (!S.balancedAfter(session, nodes)[endIdx]) throw new SurfaceChangedError('the compacted span no longer ends at a balanced boundary')
	}

	/** Append the summary record and the single surface replacement, without yielding. */
	commit(session, startEvent, plan, bundle) {
		const start = plan.regionSeqs[0]
		const end = plan.regionSeqs.at(-1)
		const summary = bundle.message.content.filter((block) => block.type === 'text')
		const summaryEvent = session.append('compaction/summary', {
			compactionId: startEvent.data.compactionId,
			...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
			summary,
			shadowedRange: { start, end },
			shadowedSeqs: [...plan.regionSeqs],
			shadowedTokenCount: plan.shadowedTokenCount,
			provider: plan.target.provider,
			model: plan.target.model,
			maxTokens: this.config.finalMaxOutputTokens,
		})
		session.append('user/message', bundle.message, {
			surfaceOp: { op: 'replace', startSeq: start, endSeq: end },
			sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...plan.regionSeqs],
		})
		return {
			compactionId: startEvent.data.compactionId,
			...(startEvent.data.sourceCommandId === undefined ? {} : { sourceCommandId: startEvent.data.sourceCommandId }),
			startSeq: startEvent.seq,
			summarySeq: summaryEvent.seq,
			summary,
			shadowedRange: { start, end },
			shadowedSeqs: [...plan.regionSeqs],
			shadowedTokenCount: plan.shadowedTokenCount,
			cardCount: bundle.cards.length,
		}
	}

	/**
	 * Context overflow: the full context no longer fits, so compact the
	 * longest balanced prefix whose final request still fits the window and
	 * keep the rest as is. Runs even when BLOCKED: the turn fails otherwise.
	 * @returns {Promise<object | null>} the compaction result, or null when nothing fits.
	 */
	async recoverOverflow(agent, signal) {
		const session = agent.session
		await this.yieldToMain(session)
		const header = session.requestHeader()
		if (!header?.config?.provider || !header?.config?.model) return null
		// Only the window matters here: pressure's reserves (main output, next
		// step) do not apply to a request that already failed.
		const info = await this.ctx.llm.resolveModelInfo(header.config.provider, header.config.model, signal)
		const window = info?.context?.contextWindow
		if (!Number.isInteger(window) || window <= 0) return null
		const limits = { window }
		const nodes = S.surfaceNodes(session)
		const measurement = this.ctx.tokenMeter.measure(session, header)
		const balanced = S.balancedAfter(session, nodes)
		const first = S.firstCompactableIndex(session, nodes)
		const fixed = measurement.totalTokens - sum(measurement.nodes, (node) => node.tokens)
		// The provider already said the context exceeds the window; an estimate
		// below the window is low by at least window/estimate, so scale by it.
		const underestimate = measurement.totalTokens < limits.window ? measurement.totalTokens / limits.window : 1
		const budget = Math.floor((limits.window - Math.ceil(limits.window * this.config.estimateBufferRatio) - 2048 - finalOutputCap(this.config, limits.window)) * underestimate)
		let end = -1
		let prefix = fixed
		for (let idx = 0; idx < nodes.length; idx += 1) {
			prefix += measurement.nodes[idx].tokens
			if (prefix > budget) break
			if (idx >= first && balanced[idx]) end = idx
		}
		if (end < first || end < 0) return null
		const state = this.state(session)
		const result = await this.finalize(agent, {
			owner: 'current-turn',
			stability: 'whole-surface',
			signal,
			region: { start: nodes[first], end: nodes[end] },
			limits: { window: limits.window },
		})
		if (!result) return null
		state.failures = 0
		state.retryAfterTokens = 0
		state.blocked = false
		const after = this.ctx.tokenMeter.measure(session, header).totalTokens
		if (after >= window) {
			// The kept tail alone is too large; a resend would overflow again.
			this.log('warn', `context overflow: compacted ${result.shadowedSeqs.length} surface nodes but ~${after} tokens remain of ${window}; not retrying`)
			return null
		}
		return result
	}

	// --- CompactionEngine contract --------------------------------------------

	/**
	 * Automatic trigger. Overflow arrives through agent/request-error
	 * (recoverOverflow), which retries the request itself.
	 */
	async compactIfNeeded(agent, trigger, signal) {
		if (trigger !== 'pressure') return null
		return this.pressure(agent, signal, 0)
	}

	/** Compact an explicit, balanced surface span (programmatic callers). */
	async compactRegion(start, end, agent, signal) {
		return this.finalize(agent, { owner: 'current-turn', stability: 'whole-surface', signal, region: { start, end } })
	}

	/** `/compact`: one finalize on an idle agent, durably checkpointed before it resolves. */
	compactNow(agent, signal, sourceCommandId) {
		signal.throwIfAborted()
		try {
			return agent.runMaintenance(async (agentSignal) => {
				const operation = AbortSignal.any([agentSignal, signal])
				try {
					operation.throwIfAborted()
					await this.yieldToMain(agent.session)
					const header = agent.session.requestHeader()
					const limits = header?.config?.provider ? await this.limitsFor(header, operation) : undefined
					return await this.finalize(agent, {
						owner: null,
						stability: 'selected-span',
						signal: operation,
						sourceCommandId,
						flush: true,
						...(limits && !limits.infeasible ? { limits } : {}),
					})
				} catch (error) {
					if (agentSignal.aborted && operation.reason === agentSignal.reason) throw new host.ManualCompactionError('cancelled', 'manual compaction was cancelled', { cause: error })
					operation.throwIfAborted()
					if (error instanceof host.ManualCompactionError) throw error
					// Before compaction/start nothing was recorded: pass the error through.
					if (!(error instanceof FinalizeError)) throw error
					const code = error.stage === 'commit' ? 'commit' : error.cause instanceof SurfaceChangedError ? 'changed' : 'summary'
					throw new host.ManualCompactionError(code, `manual compaction failed: ${error.message}`, { cause: error.cause })
				}
			})
		} catch (error) {
			throw new host.ManualCompactionError('busy', 'manual compaction requires an idle agent with no waking queued work', { cause: error })
		}
	}
}

/**
 * The `ctx.compaction` service. A cordis Service needs a live Context, so the
 * behavior lives in CardsCompactor and this class only delegates the three
 * CompactionEngine operations to it.
 */
export class CardsCompactionEngine extends host.CompactionEngine {
	static inject = ['llm', 'tokenMeter', 'sessions', 'tools']

	constructor(ctx, config) {
		super(ctx)
		this.compactor = new CardsCompactor(ctx, config, { service: this })
	}

	compactIfNeeded(agent, trigger, signal) {
		return this.compactor.compactIfNeeded(agent, trigger, signal)
	}

	compactRegion(start, end, agent, signal) {
		return this.compactor.compactRegion(start, end, agent, signal)
	}

	compactNow(agent, signal, sourceCommandId) {
		return this.compactor.compactNow(agent, signal, sourceCommandId)
	}
}

export default CardsCompactionEngine
