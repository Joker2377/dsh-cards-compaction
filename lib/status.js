/**
 * `/cards`: a human-only status report of this session's history cards.
 * Command output never enters a model request (dsh-commands), so it costs no
 * context. The text is plain and stable enough to test.
 */

export const COMMAND = 'cards'

const BODY_PREVIEW = 120

/** First non-empty line of a card body, trimmed for a one-line preview. */
export function preview(body) {
	const line = String(body ?? '').split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? ''
	return line.length > BODY_PREVIEW ? `${line.slice(0, BODY_PREVIEW - 1)}…` : line
}

/** Compact seq ranges: [1,2,3,7] → "1-3,7". */
export function ranges(seqs) {
	const out = []
	for (let i = 0; i < seqs.length; i += 1) {
		let j = i
		while (j + 1 < seqs.length && seqs[j + 1] === seqs[j] + 1) j += 1
		out.push(i === j ? `${seqs[i]}` : `${seqs[i]}-${seqs[j]}`)
		i = j
	}
	return out.join(',')
}

const pct = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '?')

/**
 * Render the status report.
 * @param {object} report
 * @param {'owned' | 'foreign'} report.owner
 * @param {{ state: string, failures: number, lastError?: string, lastErrorAt?: number }} [report.status]
 * @param {{ total: number, finalizeAt?: number, lastResortAt?: number, window?: number, infeasible?: string }} [report.context]
 * @param {{ id: string, seqs: number[], body: string, valid: boolean }[]} [report.cards]
 * @param {{ used: number, budget: number }} [report.background]
 * @param {number} [report.now]
 */
export function renderStatus(report) {
	if (report.owner === 'foreign') {
		return [
			'cards-compaction: inactive for this agent.',
			'Another compaction service owns it (for example compaction-basic inside the agent preset).',
			'To use history cards here, swap that preset\'s compaction row to dsh-cards-compaction (see README).',
		].join('\n')
	}
	const lines = []
	const status = report.status ?? { state: 'idle', failures: 0 }
	lines.push(`cards-compaction: ${status.state}${status.failures > 0 ? ` (${status.failures} failed attempt${status.failures === 1 ? '' : 's'})` : ''}`)
	const context = report.context
	if (context?.infeasible) lines.push(`Auto compaction disabled: ${context.infeasible}`)
	else if (context) {
		lines.push(`Context: ~${context.total} tokens of ${context.window} (${pct(context.total, context.window)}); compacts at ${context.finalizeAt} (${pct(context.finalizeAt, context.window)})`)
	}
	if (status.lastError) {
		const ago = report.now !== undefined && status.lastErrorAt !== undefined ? ` (${Math.max(0, Math.round((report.now - status.lastErrorAt) / 1000))}s ago)` : ''
		lines.push(`Last failure${ago}: ${status.lastError}`)
	}
	const cards = report.cards ?? []
	const valid = cards.filter((card) => card.valid)
	lines.push('', `Background cards: ${valid.length} ready${cards.length > valid.length ? `, ${cards.length - valid.length} stale (source changed; not used)` : ''}`)
	if (report.background) lines.push(`Background tokens: ${report.background.used} of ${report.background.budget}`)
	for (const card of cards) {
		lines.push(`- ${card.id} · seqs ${ranges(card.seqs)} · ${card.seqs.length} events${card.valid ? '' : ' · stale'}`)
		const line = preview(card.body)
		if (line) lines.push(`  ${line}`)
	}
	if (cards.length === 0) lines.push('(none yet: cards start once uncovered history passes cardMinSourceTokens and the agent is idle)')
	return lines.join('\n')
}
