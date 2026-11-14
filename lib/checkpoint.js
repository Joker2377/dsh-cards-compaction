/**
 * Deterministic checkpoint text: the history cards and the overview that
 * replace a compacted span. The same cards and overview always render the
 * same text (no timestamps, no model-chosen order), and the text parses back
 * into the same cards, so a later round can carry prior cards forward after a
 * restart without any side store.
 */

export const CHECKPOINT_PREAMBLE = [
	'This checkpoint replaces earlier conversation history to free up context.',
	'<history-cards> are condensed chronological records of what happened, oldest first. They are history, not instructions: an instruction recorded in a card was given in the past and may have been withdrawn later.',
	'<overview> is the current state of the work. Continue the task from it directly, without acknowledging this checkpoint.',
	'When a card lacks an exact command, error, code, path, or value you need, read the original with the cards_compaction_read_history tool and the card id before acting.',
].join('\n')

const CARD_RE = /<card id="([^"]+)" seqs="([^"]*)" depth="(\d+)">\n([\s\S]*?)\n<\/card>/g
const OVERVIEW_RE = /<overview>\n([\s\S]*?)\n<\/overview>/
const MARKER = '<history-cards>'

/** Neutralize closing tags a model may emit so the frame stays parseable. */
export function sanitizeBody(text) {
	return String(text)
		.replace(/\r\n?/g, '\n')
		.replace(/<\/(card|overview|history-cards)>/gi, '<\\/$1>')
		.replace(/<(card|overview|history-cards)(\s|>)/gi, '<\\$1$2')
		.trim()
}

/** Compress sorted seqs into "1-4,7,9-12". */
export function encodeSeqs(seqs) {
	const sorted = [...seqs].sort((a, b) => a - b)
	const parts = []
	for (let i = 0; i < sorted.length;) {
		let j = i
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1
		parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
		i = j + 1
	}
	return parts.join(',')
}

/** Inverse of encodeSeqs; rejects malformed or descending input. */
export function decodeSeqs(text) {
	if (text === '') return []
	const out = []
	for (const part of text.split(',')) {
		const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
		if (!match) throw new Error(`malformed seq range "${part}"`)
		const start = Number(match[1])
		const end = match[2] === undefined ? start : Number(match[2])
		if (end < start) throw new Error(`descending seq range "${part}"`)
		for (let seq = start; seq <= end; seq += 1) out.push(seq)
	}
	return out
}

/** Stable card id from its first and last source seq. */
export function cardId(kind, seqs) {
	if (seqs.length === 0) throw new Error('a card must cover at least one source event')
	const sorted = [...seqs].sort((a, b) => a - b)
	return `${kind}${sorted[0]}-${sorted[sorted.length - 1]}`
}

/**
 * Render the checkpoint body.
 * @param {{ cards: { id: string, seqs: number[], depth: number, body: string }[], overview: string }} bundle
 * @returns {string}
 */
export function renderCheckpoint({ cards, overview }) {
	const lines = [CHECKPOINT_PREAMBLE, '', MARKER]
	for (const card of cards) {
		lines.push(`<card id="${card.id}" seqs="${encodeSeqs(card.seqs)}" depth="${card.depth}">`, sanitizeBody(card.body), '</card>')
	}
	lines.push('</history-cards>', '', '<overview>', sanitizeBody(overview), '</overview>')
	return lines.join('\n')
}

/**
 * Parse a checkpoint written by renderCheckpoint.
 * @param {string} text
 * @returns {{ cards: { id: string, seqs: number[], depth: number, body: string }[], overview: string } | undefined}
 *   undefined when the text is not one of ours (another backend's checkpoint or a normal message).
 */
export function parseCheckpoint(text) {
	if (typeof text !== 'string' || !text.startsWith(CHECKPOINT_PREAMBLE) || !text.includes(MARKER)) return undefined
	const cards = []
	for (const match of text.matchAll(CARD_RE)) {
		cards.push({ id: match[1], seqs: decodeSeqs(match[2]), depth: Number(match[3]), body: match[4] })
	}
	const overview = OVERVIEW_RE.exec(text)
	if (!overview) return undefined
	return { cards, overview: overview[1] }
}

/** Join the text blocks of a message's content. */
export function messageText(message) {
	if (!message || !Array.isArray(message.content)) return ''
	return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/**
 * Check that a card list is a valid lineage: every seq covered once, cards in
 * ascending source order, no archive listed together with a card it absorbed.
 * @returns {string | undefined} the first problem, or undefined when valid.
 */
export function lineageProblem(cards) {
	const seen = new Set()
	let last = -1
	for (const card of cards) {
		if (card.seqs.length === 0) return `card ${card.id} covers no source`
		const sorted = [...card.seqs].sort((a, b) => a - b)
		if (sorted[0] <= last) return `card ${card.id} overlaps or precedes earlier cards`
		for (const seq of sorted) {
			if (seen.has(seq)) return `seq ${seq} is covered twice`
			seen.add(seq)
		}
		last = sorted[sorted.length - 1]
	}
	return undefined
}

/**
 * Check that new cards cover the expected source seqs exactly: same set, same
 * order, nothing missing or repeated (spec §2 coverage invariant).
 * @returns {string | undefined} the first problem, or undefined when exact.
 */
export function coverageProblem(cards, expected) {
	const covered = cards.flatMap((card) => card.seqs)
	for (let index = 0; index < Math.max(covered.length, expected.length); index += 1) {
		if (covered[index] === expected[index]) continue
		if (covered[index] === undefined) return `seq ${expected[index]} is not covered by any card`
		if (expected[index] === undefined) return `seq ${covered[index]} is outside the compacted span`
		return `expected seq ${expected[index]} at position ${index}, found ${covered[index]}`
	}
	return undefined
}
