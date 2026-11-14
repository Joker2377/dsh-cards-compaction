/**
 * cards_compaction_read_history: read back the original events behind a card
 * (spec §16). The host keeps every shadowed event in the session log, so the
 * reader only resolves a card id to its seqs and renders those events.
 *
 * Scope is the calling agent's own session: a card id or seq from another
 * session simply does not resolve here, and no path or handle is accepted.
 */
import { createHash } from 'node:crypto'
import { decodeSeqs, messageText, parseCheckpoint } from './checkpoint.js'
import { renderMessage } from './surface.js'

const { defineTool } = await import('@deepseek-ai/dsh-tools')
	.catch(() => ({ defineTool: (definition) => definition }))

export const READ_HISTORY = 'cards_compaction_read_history'
const DEFAULT_TOKENS = 4000
const MIN_TOKENS = 500
const MAX_TOKENS = 12000
const CHARS_PER_TOKEN = 4

export class HistoryReadError extends Error {
	constructor(message) {
		super(message)
		this.name = 'HistoryReadError'
	}
}

/** Card id → seqs from every checkpoint of ours in this session's log, newest wins. */
export function cardIndex(session) {
	const index = new Map()
	for (let seq = 0; seq < session.seq; seq += 1) {
		const event = session.eventAt(seq)
		if (event?.type !== 'user/message' || event.data?.source?.kind !== 'compact-checkpoint') continue
		const parsed = parseCheckpoint(messageText(event.data))
		for (const card of parsed?.cards ?? []) index.set(card.id, card.seqs)
	}
	return index
}

/** Resolve "c12-40", "a3-90" or a raw "12-40,45" seq list to seqs in this session. */
export function resolveSeqs(session, id) {
	const trimmed = String(id ?? '').trim()
	if (trimmed.length === 0) throw new HistoryReadError('id is required: a card id such as c12-40, or seqs such as 12-40')
	const known = cardIndex(session).get(trimmed)
	if (known) return known
	if (/^[ca]\d+-\d+$/.test(trimmed)) throw new HistoryReadError(`no card ${trimmed} in this session`)
	let seqs
	try {
		seqs = decodeSeqs(trimmed)
	} catch {
		throw new HistoryReadError(`"${trimmed}" is neither a card id nor a seq list`)
	}
	if (seqs.length > 5000) throw new HistoryReadError('seq list too long; read at most 5000 events per call')
	return seqs
}

/** Render the message-producing events among seqs. */
export function renderEvents(session, seqs) {
	const out = []
	for (const seq of seqs) {
		if (seq < 0 || seq >= session.seq) throw new HistoryReadError(`seq ${seq} does not exist in this session`)
		const event = session.eventAt(seq)
		if (!event) throw new HistoryReadError(`seq ${seq} is missing from the session log`)
		const message = session.deriveEventMessage(event)
		if (!message) continue
		out.push({ seq, role: message.role, text: renderMessage(message) })
	}
	return out
}

/**
 * Page through rendered events: from `cursor` (a seq), filtered by `query`,
 * up to a character budget. The digest covers the full unfiltered source so
 * a reader can tell whether two reads saw the same original.
 */
export function readHistory(session, { id, cursor, query, max_output_tokens }) {
	const seqs = resolveSeqs(session, id)
	const events = renderEvents(session, seqs)
	const digest = createHash('sha256')
	for (const event of events) digest.update(`${event.seq}\u0000${event.role}\u0000${event.text}\u0001`)
	// Cursor "seq" starts at an event; "seq:offset" continues inside one that
	// did not fit, so no part of a long event becomes unreachable.
	const match = cursor === undefined || cursor === '' ? undefined : /^(\d+)(?::(\d+))?$/.exec(String(cursor))
	if (cursor !== undefined && cursor !== '' && !match) throw new HistoryReadError(`cursor "${cursor}" is not a seq or seq:offset`)
	const fromSeq = match ? Number(match[1]) : -Infinity
	const fromOffset = match?.[2] === undefined ? 0 : Number(match[2])
	const needle = query ? String(query).toLowerCase() : undefined
	const tokens = Math.min(MAX_TOKENS, Math.max(MIN_TOKENS, Math.floor(max_output_tokens ?? DEFAULT_TOKENS)))
	const budget = tokens * CHARS_PER_TOKEN

	const lines = []
	let used = 0
	let nextCursor
	let truncated = false
	for (const event of events) {
		if (event.seq < fromSeq) continue
		if (needle && !event.text.toLowerCase().includes(needle)) continue
		const offset = event.seq === fromSeq ? fromOffset : 0
		const heading = offset > 0 ? `--- seq ${event.seq} (${event.role}), from character ${offset} ---\n` : `--- seq ${event.seq} (${event.role}) ---\n`
		const body = event.text.slice(offset)
		if (used + heading.length + body.length > budget) {
			if (lines.length === 0) {
				const room = Math.max(1, budget - heading.length)
				lines.push(`${heading}${body.slice(0, room)}\n[event continues: pass next_cursor to read the rest]`)
				truncated = true
				nextCursor = `${event.seq}:${offset + room}`
			} else {
				nextCursor = `${event.seq}`
			}
			break
		}
		lines.push(heading + body)
		used += heading.length + body.length
	}
	return {
		id: String(id),
		sources: `${seqs[0]}-${seqs.at(-1)}`,
		digest: digest.digest('hex'),
		complete: true,
		truncated,
		next_cursor: nextCursor,
		text: lines.length > 0 ? lines.join('\n\n') : (needle ? `no event matches "${query}"` : 'no message events in this range'),
	}
}

/** Format a read result for the model. */
export function formatRead(result) {
	const header = [
		`id: ${result.id}`,
		`sources: seq ${result.sources}`,
		`digest: sha256:${result.digest}`,
		`complete: ${result.complete}`,
		`truncated: ${result.truncated}`,
		`next_cursor: ${result.next_cursor ?? 'none'}`,
	].join('\n')
	return `${header}\n\n${result.text}`
}

export function createReadHistoryTool() {
	return defineTool({
		name: READ_HISTORY,
		description: [
			'Read back the original session history that a compaction checkpoint condensed into a history card: exact commands, full errors, code, and values.',
			'Call it when a card in a <history-cards> checkpoint lacks a detail you need before acting. Only this session is readable.',
			'id: a card id from the checkpoint (for example c12-40 or a3-90), or seqs such as 12-40.',
			'Long ranges are paged: pass next_cursor back as cursor. query filters events by text.',
		].join('\n'),
		parameters: {
			id: { type: 'string', description: 'Card id (c12-40, a3-90) or seq list (12-40,45).' },
			cursor: { type: 'string', description: 'next_cursor from a previous call.' },
			query: { type: 'string', description: 'Only return events containing this text.' },
			max_output_tokens: { type: 'number', description: `Output budget, ${MIN_TOKENS}-${MAX_TOKENS}; default ${DEFAULT_TOKENS}.` },
		},
		output: {
			schema: { type: 'string' },
			render: (_args, value) => [{ type: 'text', text: value }],
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const session = exec?.agent?.session
			if (!session) throw new HistoryReadError('read_history needs an agent session')
			return formatRead(readHistory(session, args ?? {}))
		},
	})
}
