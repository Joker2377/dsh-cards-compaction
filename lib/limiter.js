/**
 * Quota limiter shared by every session in this process (spec §5, §18).
 *
 * One scope per provider: the account behind a provider is not visible to a
 * plugin, so a provider is the narrowest safe scope. Foreground work (finalize)
 * always queues ahead of background work, and background work never waits:
 * it either gets a free slot now or skips.
 *
 * A slot is returned only when its request settles. A request abandoned on a
 * client timeout is not proof the server stopped, so its slot stays
 * quarantined for `quarantineMs` after the call settles.
 */
export class QuotaLimiter {
	/**
	 * @param {{ capacity: number, quarantineMs: number, now?: () => number, setTimer?: (fn: () => void, ms: number) => unknown }} options
	 */
	constructor({ capacity, quarantineMs, setTimer = (fn, ms) => setTimeout(fn, ms) }) {
		this.capacity = capacity
		this.quarantineMs = quarantineMs
		this.setTimer = setTimer
		/** @type {Map<string, { active: number, waiters: { resolve: Function, reject: Function, signal?: AbortSignal, onAbort?: Function }[] }>} */
		this.scopes = new Map()
	}

	/** Take new limits; held and quarantined slots stay counted. */
	configure({ capacity, quarantineMs }) {
		this.capacity = capacity
		this.quarantineMs = quarantineMs
		for (const [name, state] of this.scopes) {
			while (state.waiters.length > 0 && state.active < this.capacity) {
				const waiter = state.waiters.shift()
				waiter.signal?.removeEventListener('abort', waiter.onAbort)
				state.active += 1
				waiter.resolve(new Slot(this, name, false))
			}
		}
	}

	scope(name) {
		let state = this.scopes.get(name)
		if (!state) {
			state = { active: 0, background: 0, waiters: [] }
			this.scopes.set(name, state)
		}
		return state
	}

	/** Requests this plugin currently holds for a scope. */
	active(name) {
		return this.scope(name).active
	}

	/** Background requests currently in flight for a scope. */
	activeBackground(name) {
		return this.scope(name).background
	}

	/**
	 * Take a slot for background work only if one is free and no foreground
	 * work is waiting.
	 * @returns {Slot | undefined}
	 */
	tryAcquireBackground(name) {
		const state = this.scope(name)
		if (state.active >= this.capacity || state.waiters.length > 0) return undefined
		state.active += 1
		state.background += 1
		return new Slot(this, name, true)
	}

	/**
	 * Wait for a foreground slot.
	 * @param {string} name
	 * @param {AbortSignal} [signal]
	 * @returns {Promise<Slot>}
	 */
	acquireForeground(name, signal) {
		signal?.throwIfAborted()
		const state = this.scope(name)
		if (state.active < this.capacity && state.waiters.length === 0) {
			state.active += 1
			return Promise.resolve(new Slot(this, name, false))
		}
		return new Promise((resolve, reject) => {
			const waiter = { resolve, reject, signal }
			if (signal) {
				waiter.onAbort = () => {
					const index = state.waiters.indexOf(waiter)
					if (index !== -1) state.waiters.splice(index, 1)
					reject(signal.reason)
				}
				signal.addEventListener('abort', waiter.onAbort, { once: true })
			}
			state.waiters.push(waiter)
		})
	}

	/** Return one slot and hand it to the next foreground waiter. */
	release(name, background) {
		const state = this.scope(name)
		state.active -= 1
		if (background) state.background -= 1
		while (state.waiters.length > 0 && state.active < this.capacity) {
			const waiter = state.waiters.shift()
			waiter.signal?.removeEventListener('abort', waiter.onAbort)
			state.active += 1
			waiter.resolve(new Slot(this, name, false))
		}
	}
}

/** One held slot; release is idempotent. */
export class Slot {
	constructor(limiter, scope, background) {
		this.limiter = limiter
		this.scope = scope
		this.background = background
		this.released = false
	}

	/** Return the slot now: the request settled with a terminal response. */
	release() {
		if (this.released) return
		this.released = true
		this.limiter.release(this.scope, this.background)
	}

	/** Return the slot after the quarantine: the request was abandoned, not confirmed stopped. */
	releaseAfterQuarantine() {
		if (this.released) return
		this.released = true
		this.limiter.setTimer(() => this.limiter.release(this.scope, this.background), this.limiter.quarantineMs)
	}
}
