/**
 * Durable READY cards outside the session log.
 *
 * Background cards are optional and may be lost; the log stays untouched
 * (plugins outside the host repository must not write plugin records). They
 * live in the host's storage-domain service as one record per session, so a
 * restart can reuse them after re-validating their source digest.
 *
 * One process-wide domain handle is shared by every engine instance (the root
 * row and any agent preset that mounts this plugin): the domain facility
 * rejects a second open of the same name.
 */

export const DOMAIN = 'cards_compaction'
export const TABLE = 'sessions'
/** Cards kept per session; older ones are dropped first. */
export const MAX_CARDS_PER_SESSION = 64
/** Sessions kept; the least recently updated are dropped first. */
export const MAX_SESSIONS = 200

/**
 * Structural validator in the shape the domain facility calls (`parse`).
 * Invalid records throw; the facility then refuses the domain, so the
 * schema accepts only what this module writes.
 */
export const sessionRecordSchema = Object.freeze({
	parse(raw) {
		const problem = recordProblem(raw)
		if (problem) throw new Error(`invalid cards record: ${problem}`)
		return raw
	},
})

/** @returns {string | undefined} why `raw` is not a session record. */
export function recordProblem(raw) {
	if (raw === null || typeof raw !== 'object') return 'not an object'
	if (raw.v !== 1) return `unknown version ${raw.v}`
	if (!Number.isFinite(raw.updatedAt)) return 'updatedAt'
	if (!Array.isArray(raw.cards)) return 'cards'
	for (const card of raw.cards) {
		if (card === null || typeof card !== 'object') return 'card'
		if (typeof card.id !== 'string' || typeof card.body !== 'string' || typeof card.digest !== 'string') return 'card fields'
		if (!Array.isArray(card.seqs) || !card.seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0)) return 'card seqs'
	}
	return undefined
}

/**
 * Process-wide card store over an opened domain table, or memory-only when
 * the host has no storage-domain service.
 */
export class CardStore {
	constructor() {
		this.table = undefined
		this.domain = undefined
		this.opening = undefined
		this.users = 0
	}

	/**
	 * Open the domain once for every user; later callers reuse it.
	 * @param {{ open(spec): Promise<object> } | undefined} facility - `ctx.storageDomain`.
	 * @param {{ defineDomain: Function, domainTable: Function } | undefined} api - storage-domain exports.
	 * @param {(message: string) => void} [warn]
	 * @returns {() => Promise<void>} release; the last release closes the domain.
	 */
	acquire(facility, api, warn = () => {}) {
		this.users += 1
		this.startOpen(facility, api, warn)
		let released = false
		return async () => {
			if (released) return
			released = true
			this.users -= 1
			if (this.users > 0) return
			// Detach the open attempt now: an acquire that arrives while this
			// closes starts a fresh open chained after the close.
			const opening = this.opening
			this.opening = undefined
			const closing = (async () => {
				await opening
				const domain = this.domain
				this.domain = undefined
				this.table = undefined
				await domain?.close()
			})()
			this.closing = closing
			this.facility = undefined
			try {
				await closing
			} catch {
				// A failed close only costs persistence; the next open reports it.
			} finally {
				if (this.closing === closing) this.closing = undefined
			}
		}
	}

	startOpen(facility, api, warn) {
		if (!facility || !api) return
		if (this.opening && this.facility === facility) return
		if (this.opening) {
			// storage-domain reloaded: the old facility closes its domains, so
			// drop that handle and open on the new facility.
			const stale = this.opening
			this.opening = undefined
			this.closing = stale.then(async () => {
				const domain = this.domain
				this.domain = undefined
				this.table = undefined
				await domain?.close()
			}).catch(() => {})
		}
		this.facility = facility
		const after = (this.closing ?? Promise.resolve()).catch(() => {})
		const attempt = after.then(async () => {
			try {
				const spec = api.defineDomain({
					name: DOMAIN,
					version: 1,
					layout: 'per-record',
					invalidRecords: 'backup-and-skip',
					tables: { [TABLE]: api.domainTable(sessionRecordSchema) },
				})
				const domain = await facility.open(spec)
				if (this.opening !== attempt) {
					// Released before the open finished.
					await domain.close()
					return
				}
				this.domain = domain
				this.table = domain.table(TABLE)
			} catch (error) {
				warn(`background cards will not survive a restart: ${error instanceof Error ? error.message : String(error)}`)
			}
		})
		this.opening = attempt
	}

	/** Resolves when the first open attempt settles. */
	ready() {
		return this.opening ?? this.closing ?? Promise.resolve()
	}

	/** @returns {object[]} stored cards of one session; empty when absent or not open. */
	load(sessionId) {
		try {
			const record = this.table?.get(String(sessionId))
			return record ? record.cards : []
		} catch {
			// A domain closed under us (storage reload): forget it until reopened.
			this.table = undefined
			return []
		}
	}

	/**
	 * Persist one session's cards and prune old sessions.
	 * @param {string} sessionId
	 * @param {object[]} cards
	 * @param {number} now
	 */
	async save(sessionId, cards, now) {
		const table = this.table
		if (!table) return
		const kept = cards.slice(-MAX_CARDS_PER_SESSION).map((card) => ({
			id: card.id, seqs: [...card.seqs], body: card.body, digest: card.digest,
		}))
		await table.put(String(sessionId), { v: 1, updatedAt: now, cards: kept })
		await this.prune(table)
	}

	async prune(table) {
		const entries = typeof table.entries === 'function' ? [...table.entries()] : undefined
		if (!entries || entries.length <= MAX_SESSIONS) return
		entries.sort((a, b) => a[1].updatedAt - b[1].updatedAt)
		await table.deleteMany(entries.slice(0, entries.length - MAX_SESSIONS).map(([key]) => key))
	}
}

/** The shared store of this process. */
export const processStore = new CardStore()
