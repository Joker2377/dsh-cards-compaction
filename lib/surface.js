/**
 * Read-only helpers over a DSH session surface: legal boundaries, the
 * checkpoint at the head, span digests, and the replayed request prefix.
 * Nothing here appends to the session.
 */
import { createHash } from 'node:crypto'
import { messageText, parseCheckpoint } from './checkpoint.js'

/** Surface node seqs in model order. */
export function surfaceNodes(session) {
	return [...session.surface.nodes]
}

/**
 * Whether the cut after each surface node leaves no tool call unanswered.
 * Same fold as the host's toolPairingBalancedAfter, computed in one pass.
 * @returns {boolean[]} balancedAfter[i] for node i.
 */
export function balancedAfter(session, nodes = surfaceNodes(session)) {
	const out = []
	let open = 0
	for (const seq of nodes) {
		const event = session.eventAt(seq)
		if (event?.type === 'assistant/message') open += event.data.message.content.filter((block) => block.type === 'tool-call').length
		else if (event?.type === 'tool/result') open -= 1
		if (open < 0) throw new Error(`tool/result at seq ${seq} has no matching tool call`)
		out.push(open === 0)
	}
	return out
}

/** Index of the first node that may be compacted: node 0 unless it is the system message. */
export function firstCompactableIndex(session, nodes) {
	if (nodes.length === 0) return 0
	return session.eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
}

/**
 * Our checkpoint at a node, if that node is one.
 * @returns {{ cards: object[], overview: string } | undefined}
 */
export function checkpointAt(session, seq) {
	const event = session.eventAt(seq)
	if (event?.type !== 'user/message') return undefined
	if (event.data?.source?.kind !== 'compact-checkpoint') return undefined
	return parseCheckpoint(messageText(event.data))
}

/**
 * Where uncovered history starts: after our checkpoint when the surface
 * begins with one.
 */
export function coverageStart(session, nodes) {
	const first = firstCompactableIndex(session, nodes)
	const prior = first < nodes.length ? checkpointAt(session, nodes[first]) : undefined
	return { first, start: prior ? first + 1 : first, prior }
}

/** Derived model messages for surface nodes, skipping nodes that project to none. */
export function messagesFor(session, seqs) {
	const out = []
	for (const seq of seqs) {
		const message = session.deriveEventMessage(session.eventAt(seq))
		if (message) out.push(message)
	}
	return out
}

/** Content digest of a span: changes when any node is rewritten, pruned, or replaced. */
export function spanDigest(session, seqs) {
	const hash = createHash('sha256')
	for (const seq of seqs) {
		hash.update(`${seq}\u0000`)
		hash.update(JSON.stringify(session.deriveEventMessage(session.eventAt(seq)) ?? null))
		hash.update('\u0001')
	}
	return hash.digest('hex')
}

/**
 * Describe a trailing span for the instruction: how many messages, and how
 * the first one begins.
 */
export function spanDescriptor(session, seqs) {
	const messages = messagesFor(session, seqs)
	if (messages.length === 0) return { count: 0 }
	const first = messages[0]
	const text = renderMessage(first).replace(/\s+/g, ' ').trim()
	return { count: messages.length, firstRole: first.role, firstExcerpt: text.slice(0, 120).replace(/"/g, "'") }
}

/**
 * The replayed request prefix for nodes[0..endIdx]: same system message,
 * tools, and derived messages the main line sends, in the same order.
 */
export function requestPrefix(session, nodes, endIdx) {
	const header = session.requestHeader()
	return {
		messages: messagesFor(session, nodes.slice(0, endIdx + 1)),
		...(header?.tools === undefined ? {} : { tools: header.tools }),
	}
}

/** Plain-text rendering of one model message, for read_history and excerpts. */
export function renderMessage(message) {
	if (!message) return ''
	const parts = []
	for (const block of message.content ?? []) {
		switch (block.type) {
			case 'text':
				parts.push(block.text)
				break
			case 'tool-call':
				parts.push(`[tool-call ${block.name} ${typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {})}]`)
				break
			case 'reasoning':
				break
			case 'image':
				parts.push('[image]')
				break
			default:
				parts.push(`[${block.type}]`)
		}
	}
	return parts.join('\n')
}

/**
 * Pick the next background segment from the uncovered tail: start at
 * `fromIdx`, end at a balanced boundary once at least `minTokens` are covered,
 * extend while the span stays under `maxTokens`. One indivisible step may be
 * larger than `maxTokens`; an unbalanced tail is never cut.
 * @param {{ tokens: number }[]} priced - meter nodes aligned with `nodes`.
 * @returns {{ startIdx: number, endIdx: number, tokens: number } | undefined}
 */
export function selectSegment(balanced, priced, fromIdx, { minTokens, maxTokens }) {
	let total = 0
	let chosen
	for (let idx = fromIdx; idx < priced.length; idx += 1) {
		total += priced[idx].tokens
		if (!balanced[idx]) continue
		if (chosen === undefined) {
			if (total >= minTokens) chosen = { startIdx: fromIdx, endIdx: idx, tokens: total }
		} else if (total <= maxTokens) {
			chosen = { startIdx: fromIdx, endIdx: idx, tokens: total }
		} else {
			break
		}
	}
	return chosen
}
