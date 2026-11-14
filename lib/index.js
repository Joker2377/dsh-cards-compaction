/**
 * dsh-cards-compaction — background history cards; at compaction time one
 * request reads the full main context, writes the tail card and the overview,
 * and the span is replaced in one verified checkpoint. Spec: docs/spec.md.
 *
 * The entry validates config and mounts the engine as a child plugin, which
 * waits for llm, tokenMeter, sessions, and tools and then provides
 * `ctx.compaction`. The bundle patch disables the built-in compaction-basic
 * row so only one compaction owner exists (spec §12).
 */
import { Config } from './config.js'
import { CardsCompactionEngine } from './engine.js'
import { host } from './host.js'

export const name = 'dsh-cards-compaction'

/** The engine declares its own services; the entry needs none. */
export const inject = []

export { Config }

/**
 * Mount the engine. Refuses to load without the host packages: a fallback base
 * class would provide no `compaction` service while the patch has already
 * disabled compaction-basic, leaving the profile with no compaction at all
 * and no visible error (spec §19, AC33).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - already validated by Config.
 * @param {{ real: boolean }} [runtime] - test seam for the host check.
 */
export function apply(ctx, config, runtime = host) {
	if (!runtime.real) {
		throw new Error('dsh-cards-compaction needs the host packages @deepseek-ai/dsh-compaction, dsh-llm and dsh-session; it only runs inside DeepSeek Harness')
	}
	ctx.plugin(CardsCompactionEngine, config)
}
