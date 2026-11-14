/**
 * Host bindings. Inside DSH these resolve to the real packages; under plain
 * `node --test` they fall back to minimal stand-ins so the modules still
 * import without installing anything. `host.real` says which one loaded.
 */
const compaction = await import('@deepseek-ai/dsh-compaction').catch(() => undefined)
const llm = await import('@deepseek-ai/dsh-llm').catch(() => undefined)
const session = await import('@deepseek-ai/dsh-session').catch(() => undefined)
const storageDomain = await import('@deepseek-ai/dsh-storage-domain').catch(() => undefined)

class FallbackService {
	constructor(ctx) {
		this.ctx = ctx
	}
}

class FallbackManualCompactionError extends Error {
	constructor(code, message, options) {
		super(message, options)
		this.code = code
		this.name = 'ManualCompactionError'
	}
}

export const host = {
	real: compaction !== undefined && llm !== undefined && session !== undefined,
	CompactionEngine: compaction?.CompactionEngine ?? FallbackService,
	ManualCompactionError: compaction?.ManualCompactionError ?? FallbackManualCompactionError,
	compactCheckpointSource: compaction?.compactCheckpointSource
		?? ((compactionId, sourceCommandId) => Object.freeze({ kind: 'compact-checkpoint', compactionId, ...(sourceCommandId === undefined ? {} : { sourceCommandId }) })),
	createUserMessage: llm?.createUserMessage ?? ((input) => Object.freeze({ ...input, role: 'user' })),
	BlockAssembler: llm?.BlockAssembler,
	LlmError: llm?.LlmError ?? class LlmError extends Error {
		constructor(message, code, options) {
			super(message, options)
			this.code = code
		}
	},
	errorChain: llm?.errorChain ?? ((error) => [{ name: error?.name ?? 'Error', message: error instanceof Error ? error.message : String(error) }]),
	/** defineDomain / domainTable, when the host ships storage-domain. */
	storageDomain: storageDomain?.defineDomain && storageDomain?.domainTable
		? { defineDomain: storageDomain.defineDomain, domainTable: storageDomain.domainTable }
		: undefined,
}
