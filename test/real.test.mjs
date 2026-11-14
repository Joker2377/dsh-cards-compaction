/**
 * Real-host layer: the engine against the host's own dsh-session Session,
 * dsh-compaction base class and checkpoint source, dsh-llm message factories,
 * and the card store. Skips unless DSH_HOST_NODE_MODULES points at a host
 * node_modules directory (for example extracted from the installed App's
 * app.asar); see README「開發」.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test from 'node:test'

const hostModules = process.env.DSH_HOST_NODE_MODULES
const skip = !hostModules && 'needs DSH_HOST_NODE_MODULES (a DSH host node_modules directory)'

let env
async function load() {
	if (env) return env
	register(new URL('./real/resolve-host.mjs', import.meta.url))
	const [{ host }, session, compaction, llm, engineModule, tools, checkpoint, surface, helpers] = await Promise.all([
		import('../lib/host.js'),
		import('@deepseek-ai/dsh-session'),
		import('@deepseek-ai/dsh-compaction'),
		import('@deepseek-ai/dsh-llm'),
		import('../lib/engine.js'),
		import('../lib/tools.js'),
		import('../lib/checkpoint.js'),
		import('../lib/surface.js'),
		import('./helpers.mjs'),
	])
	env = { host, session, compaction, llm, engineModule, tools, checkpoint, surface, helpers }
	return env
}

/** A real Session in an open turn: system, header, user, `steps` tool steps. */
function realSession({ session: S, llm }, steps) {
	const session = S.Session.create(`real-${Math.random().toString(36).slice(2)}`)
	session.append('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] } }, { surfaceOp: 'append' })
	session.append('request/header', { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'shell', description: 'run a command', parameters: { type: 'object', properties: {} } }] } })
	session.append('turn/start', { turn: 1 })
	session.append('user/message', llm.createUserMessage({ content: [{ type: 'text', text: 'please build the importer' }] }), { surfaceOp: 'append' })
	for (let i = 1; i <= steps; i += 1) {
		const callId = `call-${i}`
		const calls = i % 3 === 0 ? [callId, `${callId}b`] : [callId]
		session.append('assistant/message', {
			message: llm.createAssistantMessage({ content: [{ type: 'text', text: `running step${i}` }, ...calls.map((id) => ({ type: 'tool-call', id, name: 'shell', arguments: JSON.stringify({ command: `step${i}` }) }))], provider: 'p', model: 'm' }),
		}, { surfaceOp: 'append' })
		for (const id of calls) {
			session.append('tool/result', { message: llm.createToolResultMessage({ callId: id, content: [{ type: 'text', text: `step${i} output ${'x'.repeat(400)}` }], isError: false }) }, { surfaceOp: 'append' })
		}
	}
	return session
}

test('real host：模組解析到 host 套件，engine 繼承真的 CompactionEngine', { skip }, async () => {
	const { host, compaction, engineModule } = await load()
	assert.equal(host.real, true)
	assert.ok(engineModule.CardsCompactionEngine.prototype instanceof compaction.CompactionEngine)
})

test('real host：真的 cordis 載入入口後，ctx.compaction 是本 engine，工具已註冊', { skip }, async () => {
	const loaded = await load()
	const { Context } = await import('@deepseek-ai/cordis')
	const entry = await import('../lib/index.js')
	const stub = loaded.helpers.fakeContext()
	const root = new Context()
	for (const name of ['llm', 'tokenMeter', 'sessions', 'tools']) {
		root.provide(name)
		root[name] = stub[name]
	}
	await root.plugin(entry, entry.Config['~standard'].validate({}).value)
	await new Promise((resolve) => setTimeout(resolve, 20))
	const service = root.get('compaction', false)
	assert.ok(service instanceof loaded.engineModule.CardsCompactionEngine)
	assert.equal(typeof service.compactNow, 'function')
	assert.deepEqual(stub.registered.map((tool) => tool.name), [loaded.tools.READ_HISTORY])
})

test('real host：我們的合法邊界與 host toolPairingBalancedAfter 逐點一致', { skip }, async () => {
	const loaded = await load()
	const session = realSession(loaded, 7)
	const nodes = [...session.surface.nodes]
	const ours = loaded.surface.balancedAfter(session, nodes)
	assert.deepEqual(ours, nodes.map((seq) => loaded.compaction.toolPairingBalancedAfter(session, seq)))
})


test('real host：finalize 一次替換，衍生訊息變成 system + checkpoint，原文仍可讀回', { skip }, async () => {
	const loaded = await load()
	const { engine } = loaded.helpers.makeEngine()
	const session = realSession(loaded, 6)
	await engine.maybeStartBackground(session)
	session.append('assistant/message', { message: loaded.llm.createAssistantMessage({ content: [{ type: 'text', text: 'tail note' }], provider: 'p', model: 'm' }) }, { surfaceOp: 'append' })
	const generation = session.surface.replaceGeneration
	const result = await engine.finalize(loaded.helpers.fakeAgent(session), { owner: 'current-turn', stability: 'whole-surface', limits: { target: 100000 } })

	assert.equal(session.surface.replaceGeneration, generation + 1)
	const messages = session.deriveMessages()
	assert.equal(messages.length, 2)
	assert.equal(messages[0].role, 'system')
	assert.equal(messages[1].role, 'user')
	assert.equal(loaded.compaction.isCompactCheckpointSource(messages[1].source), true)
	assert.equal(messages[1].source.compactionId, result.compactionId)
	const parsed = loaded.checkpoint.parseCheckpoint(loaded.checkpoint.messageText(messages[1]))
	assert.deepEqual(parsed.cards.flatMap((card) => card.seqs), result.shadowedSeqs)

	const text = await loaded.tools.createReadHistoryTool().execute({ id: parsed.cards[0].id }, { agent: { session } })
	assert.match(text, /step1 output/)
})

test('real host：失敗時鎖以 compaction/end 釋放，surface 不變', { skip }, async () => {
	const loaded = await load()
	const { engine, model } = loaded.helpers.makeEngine()
	model.respond = () => { throw new Error('provider down') }
	const session = realSession(loaded, 4)
	const nodes = [...session.surface.nodes]
	await assert.rejects(engine.finalize(loaded.helpers.fakeAgent(session), { owner: 'current-turn', stability: 'whole-surface', limits: { target: 100000 } }))
	assert.deepEqual([...session.surface.nodes], nodes)
	assert.equal(session.eventAt(session.seq - 1).type, 'compaction/end')
	assert.equal(loaded.engineModule.inspectEntryState(session).active, false)
})

test('real host：preset 隔離的 compaction 對 agent.ctx 不可見；owns() 改問 agentPresets.serviceFor 而讓出', { skip }, async () => {
	const loaded = await load()
	const { Context, Service } = await import('@deepseek-ai/cordis')
	const { createScope } = await import('@deepseek-ai/dsh-scope')
	const entry = await import('../lib/index.js')
	const stub = loaded.helpers.fakeContext()
	const root = new Context()
	for (const name of ['llm', 'tokenMeter', 'sessions', 'tools']) {
		root.provide(name)
		root[name] = stub[name]
	}
	await root.plugin(entry, entry.Config['~standard'].validate({}).value)
	await new Promise((resolve) => setTimeout(resolve, 20))
	const ours = root.get('compaction', false)

	class Basic extends Service {
		constructor(ctx) {
			super(ctx, 'compaction')
		}
	}
	const presetKey = {}
	const presetGroup = createScope(root, presetKey).ctx.isolate('compaction')
	let basic
	await presetGroup.plugin((ctx) => {
		ctx.plugin(Basic)
		ctx.inject(['compaction'], (inner) => {
			basic = inner.get('compaction', false)
		})
	})
	await new Promise((resolve) => setTimeout(resolve, 20))
	assert.ok(basic instanceof Basic)
	root.provide('agentPresets')
	root.agentPresets = { serviceFor: (agent, name) => (name === 'compaction' && agent.preset === presetKey ? basic : undefined) }

	const agentCtx = createScope(root, {}, { parent: presetKey }).ctx
	const session = loaded.helpers.fakeAgent(new loaded.helpers.FakeSession()).session
	const agent = { ctx: agentCtx, session, preset: presetKey }
	assert.equal(agentCtx.get('compaction', false).compactor, ours.compactor, 'agent.ctx 只看得到 root 的 compaction')
	assert.equal(ours.compactor.owns(agent), false)
	assert.equal(ours.compactor.owns({ ctx: agentCtx, session }), true, '沒有 preset compaction（dsh-base）時照常擁有')
})

test('real host：card store 經真的 storage-domain＋json backend 寫入並在重開後讀回', { skip }, async () => {
	await load()
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join } = await import('node:path')
	const { Context } = await import('@deepseek-ai/cordis')
	const storage = await import('@deepseek-ai/dsh-storage')
	const json = await import('@deepseek-ai/dsh-storage-json')
	const domainModule = await import('@deepseek-ai/dsh-storage-domain')
	const { CardStore } = await import('../lib/store.js')
	const { host } = await import('../lib/host.js')
	assert.ok(host.storageDomain, 'host 套件提供 defineDomain/domainTable')
	const root = await mkdtemp(join(tmpdir(), 'cards-store-'))
	const mount = async () => {
		const ctx = new Context()
		await ctx.plugin(storage.default, {})
		await ctx.plugin(json, { root })
		await ctx.plugin(domainModule, { backend: 'json' })
		await new Promise((resolve) => setTimeout(resolve, 50))
		const facility = ctx.get('storageDomain', false)
		assert.ok(facility, 'storageDomain 已提供')
		return { ctx, facility }
	}
	try {
		const first = await mount()
		const store = new CardStore()
		const release = store.acquire(first.facility, host.storageDomain, (message) => assert.fail(message))
		await store.ready()
		await store.save('session-a', [{ id: 'c1-3', seqs: [1, 2, 3], depth: 0, body: 'card body', digest: 'd' }], 1)
		await release()

		const second = await mount()
		const reopened = new CardStore()
		const release2 = reopened.acquire(second.facility, host.storageDomain, (message) => assert.fail(message))
		await reopened.ready()
		assert.deepEqual(reopened.load('session-a'), [{ id: 'c1-3', seqs: [1, 2, 3], body: 'card body', digest: 'd' }])
		await release2()
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
