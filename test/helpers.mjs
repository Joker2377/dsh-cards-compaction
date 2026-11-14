/**
 * Test doubles shaped after the host APIs the engine reads (dsh-session,
 * dsh-token-meter, dsh-llm, cordis ctx). Only methods the host really has are
 * implemented; each mirrors the host rule it stands in for.
 */
import { CardsCompactor } from '../lib/engine.js'
import { QuotaLimiter } from '../lib/limiter.js'

const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Same projection rule as dsh-session deriveEventMessage. */
function derive(event) {
	switch (event.type) {
		case 'user/message': return event.data
		case 'system/message':
		case 'assistant/message':
			return event.data.message.content.length === 0 ? null : event.data.message
		case 'tool/result': return event.data.message
		default: return null
	}
}

let sessionCounter = 0

export class FakeSession {
	constructor({ provider = 'p', model = 'm', tools = [{ name: 'shell', description: 'run', parameters: {} }] } = {}) {
		this.id = `s${++sessionCounter}`
		this.log = []
		this.nodes = []
		this.replaceGeneration = 0
		this.header = { config: { provider, model }, tools }
		this.listeners = []
		this.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] } })
	}

	get seq() { return this.log.length }
	get surface() { return { nodes: [...this.nodes], replaceGeneration: this.replaceGeneration } }
	eventAt(seq) { return this.log[seq] }
	deriveEventMessage(event) { return derive(event) }
	requestHeader() { return this.header }
	toolHistory() { return { additions: [] } }

	append(type, data, opts) {
		const event = Object.freeze({ type, seq: this.log.length, time: 0, data, ...(opts ?? {}) })
		this.log.push(event)
		if (opts?.surfaceOp?.op === 'replace') {
			const from = this.nodes.indexOf(opts.surfaceOp.startSeq)
			const to = this.nodes.indexOf(opts.surfaceOp.endSeq)
			if (from === -1 || to === -1 || to < from) throw new Error('bad replace')
			this.nodes.splice(from, to - from + 1, event.seq)
			this.replaceGeneration += 1
		} else if (SURFACE_TYPES.has(type)) {
			this.nodes.push(event.seq)
		}
		for (const listener of this.listeners) listener(event)
		return event
	}

	appendPluginRecord(type, data) {
		const event = Object.freeze({ type, seq: this.log.length, time: 0, data, ignorable: true })
		this.log.push(event)
		return event.seq
	}

	// --- conversation builders ---
	user(text) { return this.append('user/message', { role: 'user', content: [{ type: 'text', text }] }) }
	assistant(text, calls = []) {
		const content = [...(text ? [{ type: 'text', text }] : []), ...calls.map((call, index) => ({ type: 'tool-call', id: `call-${this.seq}-${index}`, name: call.name ?? 'shell', arguments: call.args ?? '{}' }))]
		return this.append('assistant/message', { message: { role: 'assistant', content } })
	}
	toolResult(text) { return this.append('tool/result', { message: { role: 'tool', content: [{ type: 'text', text }] } }) }
	turnStart(turn = 1) { return this.append('turn/start', { turn }) }
	turnEnd(turn = 1) { return this.append('turn/end', { turn }) }

	/** One step: a tool call with a result of `size` characters. */
	step(label, size = 400) {
		this.assistant(`running ${label}`, [{ args: JSON.stringify({ command: label }) }])
		this.toolResult(`${label} output ${'x'.repeat(size)}`)
	}

	/** Surface node texts, for assertions. */
	surfaceTexts() {
		return this.nodes.map((seq) => {
			const message = derive(this.log[seq])
			return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
		})
	}
}

/** Heuristic meter: ~4 chars per token plus framing, like the host's estimate. */
export function estimate(message) {
	if (!message) return 0
	let chars = 0
	for (const block of message.content ?? []) chars += block.type === 'text' ? block.text.length : JSON.stringify(block).length
	return Math.ceil(chars / 4) + 4
}

export class FakeMeter {
	constructor({ toolsTokens = 100 } = {}) {
		this.toolsTokens = toolsTokens
	}

	measure(session) {
		const nodes = session.surface.nodes.map((seq) => {
			const tokens = estimate(session.deriveEventMessage(session.eventAt(seq)))
			return { seq, tokens, heuristicTokens: tokens }
		})
		const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0)
		return { totalTokens: this.toolsTokens + surfaceTokens, surfaceTokens, nodes }
	}

	estimateMessage(message) { return estimate(message) }
}

/**
 * Scripted generator: answers by instruction kind and records every request.
 * Override `respond` per test to inject failures.
 */
export class FakeModel {
	constructor() {
		this.calls = []
		this.respond = (kind, request) => {
			if (kind === 'final') return '<tail_card>\nuser: tail work\nresult: exit=0\n</tail_card>\n<overview>\n## Goal\nship it\n## Next step\ncontinue\n</overview>'
			if (kind === 'archive') return 'archive: short'
			return `card: ${request.prefix.messages.length} msgs`
		}
	}

	kindOf(instruction) {
		if (instruction.includes('<tail_card>')) return 'final'
		if (instruction.includes('history archivist')) return 'archive'
		return 'card'
	}

	generate = async (request) => {
		const kind = this.kindOf(request.instruction)
		this.calls.push({ kind, ...request })
		const text = await this.respond(kind, request)
		return { text, usage: { inputTokens: 10, outputTokens: 5 } }
	}
}

/** Minimal cordis-like ctx with the services the engine injects. */
export function fakeContext({ contextWindow = 20000, defaultMaxTokens = 1000 } = {}) {
	const handlers = new Map()
	const registered = []
	const logs = []
	const ctx = {
		handlers,
		registered,
		logs,
		on(name, fn) {
			if (!handlers.has(name)) handlers.set(name, [])
			handlers.get(name).push(fn)
			return () => {}
		},
		effect() {},
		tools: { register: (tool) => { registered.push(tool); return () => {} } },
		tokenMeter: new FakeMeter(),
		llm: { resolveModelInfo: async () => ({ context: { contextWindow }, defaultMaxTokens }) },
		sessions: { flushed: 0, async flush() { this.flushed += 1 } },
		logger: { info: (m) => logs.push(['info', m]), warn: (m) => logs.push(['warn', m]), debug: (m) => logs.push(['debug', m]) },
	}
	return ctx
}

/** Small budgets so a few steps cross every threshold. */
export const TEST_CONFIG = {
	cardMinSourceTokens: 300,
	cardMaxSourceTokens: 900,
	backgroundMinIntervalMs: 0,
	nextStepReserveTokens: 1000,
	finalMaxOutputTokens: 1000,
	cardMaxOutputTokens: 500,
	candidateWaitMs: 20,
	backgroundAttemptTimeoutMs: 2000,
	finalAttemptTimeoutMs: 2000,
	quarantineMs: 10,
}

export function makeEngine({ config = {}, ctxOptions = {}, model = new FakeModel(), capacity = 1 } = {}) {
	const ctx = fakeContext(ctxOptions)
	const limiter = new QuotaLimiter({ capacity, quarantineMs: 10 })
	const engine = new CardsCompactor(ctx, { ...TEST_CONFIG, ...config }, { limiter, generate: model.generate })
	return { ctx, engine, model, limiter }
}

export function fakeAgent(session) {
	return {
		session,
		options: {},
		async runMaintenance(job) {
			return job(new AbortController().signal)
		},
	}
}
