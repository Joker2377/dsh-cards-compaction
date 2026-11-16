/**
 * One model generation outside the agent loop (spec §6, R01): the replayed
 * prefix plus one trailing user instruction, streamed once. No tool executor
 * is involved; output that contains a tool call is rejected even when it also
 * has text, so nothing the worker "asks for" is ever treated as executed.
 */
import { host } from './host.js'

export class GenerationError extends Error {
	constructor(message, code, options) {
		super(message, options)
		this.name = 'GenerationError'
		this.code = code
	}
}

/**
 * Validate assembled output blocks and finish state.
 * @returns {string} the text output.
 */
export function acceptOutput(blocks, finish, detail = {}) {
	if (finish?.kind === 'max-tokens') {
		const what = detail.kind ? `${detail.kind} output` : 'output'
		const cap = Number.isInteger(detail.maxTokens) ? `the ${detail.maxTokens}-token cap` : 'the token cap'
		const used = Number.isInteger(detail.outputTokens) ? ` after ${detail.outputTokens} output tokens` : ''
		throw new GenerationError(`${what} truncated at ${cap}${used} (reasoning counts toward it)`, 'MAX_TOKENS')
	}
	if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new GenerationError(finish.failure?.message ?? `generation ${finish.kind}`, finish.failure?.code ?? finish.kind.toUpperCase())
	if (blocks.some((block) => block.type === 'tool-call')) throw new GenerationError('output contains a tool call; workers have no tool executor', 'TOOL_CALL')
	if (blocks.some((block) => block.type === 'image')) throw new GenerationError('output contains an image', 'UNSUPPORTED_CONTENT')
	const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('').trim()
	if (text.length === 0) throw new GenerationError('output has no text', 'EMPTY')
	return text
}

/**
 * Stream one request through ctx.llm and return its text.
 * @param {object} ctx - context with `llm`.
 * @param {{ provider: string, model: string, messages: object[], tools?: object[], toolHistory?: unknown, maxTokens: number, sessionId: string, signal?: AbortSignal }} request
 * @returns {Promise<{ text: string, usage?: object }>}
 */
export async function streamText(ctx, request) {
	if (!host.BlockAssembler) throw new GenerationError('dsh-llm is not available', 'UNAVAILABLE')
	const assembler = new host.BlockAssembler()
	const options = {
		provider: request.provider,
		model: request.model,
		messages: request.messages,
		...(request.toolHistory === undefined ? {} : { toolHistory: request.toolHistory }),
		...(request.tools === undefined ? {} : { tools: [...request.tools] }),
		maxTokens: request.maxTokens,
		sessionId: request.sessionId,
		purpose: 'compaction',
		...(request.signal === undefined ? {} : { signal: request.signal }),
	}
	for await (const chunk of ctx.llm.stream(options)) {
		request.onProgress?.()
		assembler.push(chunk)
	}
	const text = acceptOutput(assembler.blocks(), assembler.finish, { kind: request.kind, maxTokens: request.maxTokens, outputTokens: assembler.usage?.outputTokens })
	return { text, ...(assembler.usage === undefined ? {} : { usage: assembler.usage }) }
}

/** Errors worth one more attempt: anything except cancellation. */
export function retryable(error, signal) {
	if (signal?.aborted) return false
	if (error?.code === 'CONTEXT_WINDOW_EXCEEDED') return false
	return !(error?.name === 'AbortError')
}
