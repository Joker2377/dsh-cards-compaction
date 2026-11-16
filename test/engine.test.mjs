import assert from 'node:assert/strict'
import test from 'node:test'

import { messageText, parseCheckpoint } from '../lib/checkpoint.js'
import { CardsCompactor, inspectEntryState } from '../lib/engine.js'
import { QuotaLimiter } from '../lib/limiter.js'
import { createReadHistoryTool } from '../lib/tools.js'
import { FakeModel, FakeSession, TEST_CONFIG, fakeAgent, fakeContext, makeEngine } from './helpers.mjs'

const AUTO = { owner: 'current-turn', stability: 'whole-surface', limits: { target: 100000 } }

/** A session inside an open turn with `steps` tool steps. */
function working(steps = 4, size = 400) {
	const session = new FakeSession()
	session.turnStart()
	session.user('please build the importer')
	for (let i = 1; i <= steps; i += 1) session.step(`step${i}`, size)
	return session
}

function checkpointOf(session) {
	assert.equal(session.nodes.length, 2, 'surface is system + checkpoint')
	return parseCheckpoint(messageText(session.eventAt(session.nodes[1]).data))
}

const deferred = () => {
	let resolve
	const promise = new Promise((r) => { resolve = r })
	return { promise, resolve }
}

// --- background -------------------------------------------------------------------

test('背景產卡：不改主線、不寫 log，READY card 存進 card store', async () => {
	const { engine, model, store } = makeEngine()
	const session = working()
	const surfaceBefore = [...session.nodes]
	await engine.maybeStartBackground(session)
	assert.deepEqual(session.nodes, surfaceBefore, '主線 surface 不變')
	const [card] = engine.state(session).cards.values()
	assert.ok(card, 'card READY')
	assert.equal(card.seqs[0], session.nodes[1], '從 system 之後開始')
	assert.ok(!session.log.some((event) => /^plugin:/.test(event.type)), '不寫 plugin record')
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.deepEqual(store.load(session.id).map((stored) => stored.id), [card.id], '存進 card store')
	assert.equal(model.calls.length, 1)
})

test('背景請求：prefix 與主線前綴逐項相同，任務指令只在尾端', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	await engine.maybeStartBackground(session)
	const { prefix, instruction } = model.calls[0]
	const main = session.nodes.map((seq) => session.deriveEventMessage(session.eventAt(seq)))
	assert.deepEqual(prefix.messages, main.slice(0, prefix.messages.length))
	assert.deepEqual(prefix.tools, session.requestHeader().tools)
	assert.match(instruction, /LAST \d+ message/)
	assert.ok(!prefix.messages.some((message) => JSON.stringify(message).includes('history recorder')))
})

test('背景產卡期間主線追加事件：card 仍採用，新事件留給下一張', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	const gate = deferred()
	model.respond = async () => {
		await gate.promise
		return 'card body'
	}
	const job = engine.maybeStartBackground(session)
	session.step('during', 400)
	gate.resolve()
	await job
	const [card] = engine.state(session).cards.values()
	assert.ok(card)
	assert.ok(!card.seqs.includes(session.nodes.at(-1)), '新事件不在這張卡裡')
})

test('背景產卡期間來源被改寫：舊候選不採用', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	const gate = deferred()
	model.respond = async () => {
		await gate.promise
		return 'card body'
	}
	const job = engine.maybeStartBackground(session)
	session.append('user/message', { role: 'user', content: [{ type: 'text', text: 'rewritten' }] }, { surfaceOp: { op: 'replace', startSeq: session.nodes[1], endSeq: session.nodes[3] } })
	gate.resolve()
	await job
	assert.equal(engine.state(session).cards.size, 0)
})

test('背景輸出被拒（例如含 tool call）：沒有 READY card，slot 歸還', async () => {
	const { engine, model, limiter } = makeEngine()
	const session = working()
	model.respond = () => { throw new Error('output contains a tool call') }
	await engine.maybeStartBackground(session)
	assert.equal(engine.state(session).cards.size, 0)
	assert.equal(limiter.active('p'), 0)
})

test('停用外掛：進行中的背景卡被取消，結果不存', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	const gate = deferred()
	model.respond = async () => {
		await gate.promise
		return 'card body'
	}
	const job = engine.maybeStartBackground(session)
	engine.dispose()
	gate.resolve()
	await job
	assert.equal(engine.state(session).cards.size, 0)
	assert.equal(engine.maybeStartBackground(session), undefined, '停用後不再啟動')
})

test('單併發：主線推論中不啟動背景卡', () => {
	const { engine } = makeEngine()
	const session = working()
	engine.beginInference(session, 'p')
	assert.equal(engine.maybeStartBackground(session), undefined)
	engine.endInference(session)
	assert.ok(engine.maybeStartBackground(session))
})

test('背景費用上限：達上限後不再產卡', async () => {
	const { engine } = makeEngine({ config: { backgroundTokenBudget: 1 } })
	const session = working(8)
	await engine.maybeStartBackground(session)
	assert.equal(engine.maybeStartBackground(session), undefined)
})

// --- finalize -------------------------------------------------------------------------

test('finalize：採用背景卡＋尾段卡，完整覆蓋後一次替換', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	await engine.maybeStartBackground(session)
	session.step('after-card', 400)
	const region = session.nodes.slice(1)
	const result = await engine.finalize(fakeAgent(session), AUTO)
	const checkpoint = checkpointOf(session)
	assert.equal(checkpoint.cards.length, 2)
	assert.deepEqual(checkpoint.cards.flatMap((card) => card.seqs), region, '每個來源剛好一次、依序')
	assert.match(checkpoint.overview, /ship it/)
	assert.deepEqual(result.shadowedSeqs, region)
	const types = session.log.slice(result.startSeq).map((event) => event.type)
	assert.deepEqual(types, ['compaction/start', 'compaction/summary', 'user/message', 'compaction/end'])
	assert.equal(model.calls.filter((call) => call.kind === 'final').length, 1)
})

test('finalize：最後請求讀完整 cutoff 主線，不以 cards 取代仍在主線的原文', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	await engine.maybeStartBackground(session)
	const main = session.nodes.map((seq) => session.deriveEventMessage(session.eventAt(seq)))
	await engine.finalize(fakeAgent(session), AUTO)
	const final = model.calls.find((call) => call.kind === 'final')
	assert.deepEqual(final.prefix.messages, main)
})

test('finalize：沒有尾段時 tail_card 為空，只用背景卡', async () => {
	const { engine, model } = makeEngine({ config: { cardMaxSourceTokens: 100000 } })
	const session = working()
	await engine.maybeStartBackground(session)
	const base = model.respond
	model.respond = (kind, request) => (kind === 'final'
		? (assert.match(request.instruction, /exactly EMPTY/), '<tail_card>\nEMPTY\n</tail_card>\n<overview>\nstate\n</overview>')
		: base(kind, request))
	await engine.finalize(fakeAgent(session), AUTO)
	assert.equal(checkpointOf(session).cards.length, 1)
})

test('finalize：還在跑的背景卡等短期限後不採用，遲到結果不補進 assembly', async () => {
	const { engine, model } = makeEngine({ capacity: 2 })
	const session = working()
	const gate = deferred()
	const base = model.respond
	model.respond = async (kind, request) => {
		if (kind === 'card') await gate.promise
		return base(kind, request)
	}
	const job = engine.maybeStartBackground(session)
	const region = session.nodes.slice(1)
	await engine.finalize(fakeAgent(session), AUTO)
	gate.resolve()
	await job
	const checkpoint = checkpointOf(session)
	assert.equal(checkpoint.cards.length, 1, '只有尾段卡')
	assert.deepEqual(checkpoint.cards[0].seqs, region)
	assert.equal(engine.state(session).cards.size, 0, '遲到的卡沒有存成 READY')
})

test('finalize：尾段太大時先補卡，不切掉尾段', async () => {
	const { engine, model } = makeEngine()
	const session = working(12)
	const region = session.nodes.slice(1)
	await engine.finalize(fakeAgent(session), AUTO)
	const checkpoint = checkpointOf(session)
	assert.ok(checkpoint.cards.length >= 2)
	assert.deepEqual(checkpoint.cards.flatMap((card) => card.seqs), region)
	assert.ok(model.calls.some((call) => call.kind === 'card'))
})

test('第二輪：沿用前輪 cards、取代舊 overview，不累加', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	await engine.finalize(fakeAgent(session), AUTO)
	const first = checkpointOf(session)
	session.step('round2', 400)
	const base = model.respond
	model.respond = (kind, request) => (kind === 'final' ? '<tail_card>\nround2 work\n</tail_card>\n<overview>\nsecond overview\n</overview>' : base(kind, request))
	await engine.finalize(fakeAgent(session), AUTO)
	const second = checkpointOf(session)
	assert.deepEqual(second.cards.slice(0, first.cards.length), first.cards)
	assert.equal(second.cards.length, first.cards.length + 1)
	assert.equal(second.overview, 'second overview')
	const text = messageText(session.eventAt(session.nodes[1]).data)
	assert.equal(text.match(/<overview>\n/g).length, 1)
})

test('超過 cards 預算：合併最舊的 cards 成 archive，lineage 等於來源聯集', async () => {
	const { engine, model } = makeEngine()
	const long = 'detail '.repeat(90)
	model.respond = (kind) => {
		if (kind === 'final') return `<tail_card>
${long}
</tail_card>
<overview>
state
</overview>`
		if (kind === 'archive') return 'archive: short'
		return long
	}
	const session = working()
	for (let round = 0; round < 3; round += 1) {
		await engine.finalize(fakeAgent(session), AUTO)
		session.step(`more${round}`, 3000)
	}
	const previous = session.eventAt(session.nodes[1]).data
	const before = parseCheckpoint(messageText(previous))
	const oldest = before.cards.slice(0, 2).flatMap((card) => card.seqs)
	const meter = engine.ctx.tokenMeter
	const measured = meter.measure(session)
	const fixed = measured.totalTokens - measured.nodes.slice(1).reduce((total, node) => total + node.tokens, 0)
	// The previous checkpoint fits; adding one more long tail card does not.
	const target = fixed + meter.estimateMessage(previous) + 60
	await engine.finalize(fakeAgent(session), { ...AUTO, limits: { target } })
	const after = checkpointOf(session)
	assert.ok(model.calls.some((call) => call.kind === 'archive'))
	const archive = after.cards[0]
	assert.match(archive.id, /^a/)
	assert.equal(archive.depth, 1)
	assert.deepEqual(archive.seqs.slice(0, oldest.length), oldest)
	assert.deepEqual(after.cards.flatMap((card) => card.seqs), [...before.cards.flatMap((card) => card.seqs), ...after.cards.at(-1).seqs])
})

test('最後生成失敗：主線完全不變，鎖以帶錯誤的 compaction/end 釋放', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	model.respond = (kind) => (kind === 'final' ? '<tail_card>x</tail_card><overview>cut' : 'card')
	const before = [...session.nodes]
	await assert.rejects(engine.finalize(fakeAgent(session), AUTO), /overview/)
	assert.deepEqual(session.nodes, before)
	const end = session.log.at(-1)
	assert.equal(end.type, 'compaction/end')
	assert.ok(end.data.error)
	assert.equal(inspectEntryState(session).active, false)
	assert.equal(model.calls.filter((call) => call.kind === 'final').length, TEST_CONFIG.maxAttemptsPerRequest ?? 2)
})

test('提交前收到 stop：取消 finalize、保留主線', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	const abort = new AbortController()
	const base = model.respond
	model.respond = (kind, request) => {
		if (kind === 'final') abort.abort(new Error('user stop'))
		return base(kind, request)
	}
	const before = [...session.nodes]
	await assert.rejects(engine.finalize(fakeAgent(session), { ...AUTO, signal: abort.signal }), /user stop/)
	assert.deepEqual(session.nodes, before)
	assert.equal(session.log.at(-1).type, 'compaction/end')
})

test('生成期間主線被改寫：不提交舊 overview', async () => {
	const { engine, model } = makeEngine()
	const session = working()
	const base = model.respond
	model.respond = (kind, request) => {
		if (kind === 'final') session.step('sneaked-in', 50)
		return base(kind, request)
	}
	await assert.rejects(engine.finalize(fakeAgent(session), AUTO), /changed/)
	assert.ok(session.surfaceTexts().some((text) => text.includes('sneaked-in')))
	assert.equal(session.log.at(-1).type, 'compaction/end')
})

test('已有 compaction 鎖：第二個 owner 進不來', async () => {
	const { engine } = makeEngine()
	const session = working()
	session.append('compaction/start', { compactionId: 'other', turn: 1 })
	await assert.rejects(engine.finalize(fakeAgent(session), AUTO), (error) => error.code === 'busy')
})

test('同一 session 並行兩次 finalize：只有一個提交', async () => {
	const { engine } = makeEngine()
	const session = working()
	const results = await Promise.allSettled([engine.finalize(fakeAgent(session), AUTO), engine.finalize(fakeAgent(session), AUTO)])
	assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
	assert.equal(session.log.filter((event) => event.surfaceOp?.op === 'replace').length, 1)
})

test('提交目標放不下：拒絕提交、主線不變', async () => {
	const { engine } = makeEngine()
	const session = working()
	const before = [...session.nodes]
	await assert.rejects(engine.finalize(fakeAgent(session), { ...AUTO, limits: { target: 50 } }), /budget|fit|merged/)
	assert.deepEqual(session.nodes, before)
})

test('只有 system 或只有前輪 checkpoint：no-op，不產空 checkpoint', async () => {
	const { engine } = makeEngine()
	const session = new FakeSession()
	session.turnStart()
	assert.equal(await engine.finalize(fakeAgent(session), AUTO), null)
	const other = working()
	await engine.finalize(fakeAgent(other), AUTO)
	assert.equal(await engine.finalize(fakeAgent(other), AUTO), null)
	assert.equal(other.log.filter((event) => event.type === 'compaction/start').length, 1)
})

// --- triggers ---------------------------------------------------------------------

test('pressure：低於門檻不動；超過門檻在 pre-step 切換並繼續下一步', async () => {
	const { engine, ctx } = makeEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	const small = working(1)
	assert.equal(await engine.pressure(fakeAgent(small), undefined, 0), null)

	const session = working(20, 1200)
	const [preStep] = ctx.handlers.get('agent/pre-step')
	let continued = false
	await preStep({ agent: fakeAgent(session), messages: [], signal: new AbortController().signal }, async () => { continued = true })
	assert.equal(continued, true)
	assert.ok(checkpointOf(session))
})

test('pressure：連續失敗後 BLOCKED，不再每步重試', async () => {
	const { engine, model } = makeEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	const session = working(20, 1200)
	model.respond = () => { throw new Error('provider down') }
	const agent = fakeAgent(session)
	await assert.rejects(engine.pressure(agent, undefined, 0))
	session.step('grow', 2000)
	await assert.rejects(engine.pressure(agent, undefined, 0))
	assert.equal(engine.state(session).blocked, true)
	const calls = model.calls.length
	assert.equal(await engine.pressure(agent, undefined, 0), null)
	assert.equal(model.calls.length, calls)
})

test('pre-step：finalize 失敗也照常進下一步', async () => {
	const { ctx, model } = makeEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	model.respond = () => { throw new Error('provider down') }
	const session = working(20, 1200)
	let continued = false
	await ctx.handlers.get('agent/pre-step')[0]({ agent: fakeAgent(session), messages: [], signal: new AbortController().signal }, async () => { continued = true })
	assert.equal(continued, true)
	assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /continuing with the full context/.test(message)))
})

test('context-overflow：不以 cards 代替完整輸入，回 null 讓 host 錯誤成立', async () => {
	const { engine, model } = makeEngine()
	assert.equal(await engine.compactIfNeeded(fakeAgent(working()), 'context-overflow'), null)
	assert.equal(model.calls.length, 0)
})

test('/compact：閒置時 finalize、flush，回傳 command-compact 讀的欄位', async () => {
	const { engine, ctx } = makeEngine()
	const session = working()
	session.turnEnd()
	const result = await engine.compactNow(fakeAgent(session), new AbortController().signal, 'cmd-1')
	assert.ok(result.shadowedSeqs.length > 0)
	assert.equal(typeof result.shadowedTokenCount, 'number')
	assert.equal(typeof result.summarySeq, 'number')
	assert.equal(result.sourceCommandId, 'cmd-1')
	assert.equal(ctx.sessions.flushed, 1)
	assert.equal(session.eventAt(session.nodes[1]).data.source.sourceCommandId, 'cmd-1')
})

test('/compact：有 open turn 時回 busy', async () => {
	const { engine } = makeEngine()
	await assert.rejects(engine.compactNow(fakeAgent(working()), new AbortController().signal), (error) => error.code === 'busy')
})

// --- restart and reader -------------------------------------------------------------

test('重啟：從 card store 重建 READY card，採用前重驗來源', async () => {
	const first = makeEngine()
	const session = working()
	await first.engine.maybeStartBackground(session)
	const [card] = first.engine.state(session).cards.values()

	const model = new FakeModel()
	await new Promise((resolve) => setTimeout(resolve, 0))
	const engine = new CardsCompactor(fakeContext(), TEST_CONFIG, { limiter: new QuotaLimiter({ capacity: 1, quarantineMs: 0 }), generate: model.generate, store: first.store })
	assert.ok(engine.state(session).cards.has(card.id))
	await engine.finalize(fakeAgent(session), AUTO)
	assert.equal(checkpointOf(session).cards[0].body, card.body)
	assert.equal(model.calls.filter((call) => call.kind === 'card').length, 0, '沒有重做已有的卡')
})

test('read_history：以 card id 讀回原文，digest 穩定、可分頁', async () => {
	const { engine } = makeEngine()
	const session = working()
	await engine.finalize(fakeAgent(session), AUTO)
	const [card] = checkpointOf(session).cards
	const tool = createReadHistoryTool()
	const exec = { agent: { session } }
	const full = await tool.execute({ id: card.id }, exec)
	assert.match(full, /step1 output/)
	assert.match(full, /please build the importer/)
	assert.equal(full.match(/digest: (\S+)/)[1], (await tool.execute({ id: card.id }, exec)).match(/digest: (\S+)/)[1])

	const page = await tool.execute({ id: card.id, max_output_tokens: 500 }, exec)
	const cursor = page.match(/next_cursor: (\S+)/)[1]
	assert.notEqual(cursor, 'none')
	const next = await tool.execute({ id: card.id, cursor, max_output_tokens: 500 }, exec)
	assert.ok(!next.includes(page.split('\n\n')[1]))

	const hit = await tool.execute({ id: card.id, query: 'step3' }, exec)
	assert.match(hit, /step3/)
	assert.doesNotMatch(hit, /step1 output/)
})

test('read_history：不存在的 card、別的 session、越界 seq 都明確報錯', async () => {
	const { engine } = makeEngine()
	const session = working()
	await engine.finalize(fakeAgent(session), AUTO)
	const [card] = checkpointOf(session).cards
	const tool = createReadHistoryTool()
	await assert.rejects(tool.execute({ id: 'c900-901' }, { agent: { session } }), /no card/)
	await assert.rejects(tool.execute({ id: card.id }, { agent: { session: new FakeSession() } }), /no card/)
	await assert.rejects(tool.execute({ id: '99999' }, { agent: { session } }), /does not exist/)
	await assert.rejects(tool.execute({ id: card.id }, {}), /agent session/)
})

// --- review fixes ---------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Host topology: `agent.ctx` cannot see a preset's isolated realm, so it always
 * resolves the root `compaction` (ours); only `agentPresets.serviceFor` knows
 * the preset's own service. `presetCompaction` undefined = no preset compaction.
 */
function scopedAgent(session, engine, presetCompaction) {
	return { ...fakeAgent(session), presetCompaction, ctx: { get: (name) => (name === 'compaction' ? engine.service : undefined) } }
}

function ownedEngine(options = {}) {
	const made = makeEngine(options)
	made.engine.service = { compactor: made.engine }
	const presets = { serviceFor: (agent, name) => (name === 'compaction' ? agent.presetCompaction : undefined) }
	const get = made.ctx.get
	made.ctx.get = (name, ...rest) => (name === 'agentPresets' ? presets : get?.(name, ...rest))
	return made
}

test('別的 compaction 擁有這個 agent（preset 內的 basic）：不自動切換、不產背景卡', async () => {
	const { engine, ctx, model } = ownedEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	const session = working(20, 1200)
	const agent = scopedAgent(session, engine, { compactor: {} })
	let continued = false
	await ctx.handlers.get('agent/pre-step')[0]({ agent, messages: [], signal: new AbortController().signal }, async () => { continued = true })
	assert.equal(continued, true)
	assert.equal(session.nodes.length > 2, true, '沒有替換')
	assert.equal(engine.maybeStartBackground(session), undefined)
	assert.equal(model.calls.length, 0)
	assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /another compaction service/.test(message)))
})

test('preset 裡換成本外掛：root 那份讓出，preset 那份動作', async () => {
	const root = ownedEngine()
	const inPreset = ownedEngine()
	const session = working()
	const agent = scopedAgent(session, root.engine, inPreset.engine.service)
	assert.equal(root.engine.owns(agent), false)
	assert.equal(inPreset.engine.owns(agent), true)
})

test('本 engine 就是 agent 看到的 compaction：照常切換', async () => {
	const { engine, ctx } = ownedEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	const session = working(20, 1200)
	await ctx.handlers.get('agent/pre-step')[0]({ agent: scopedAgent(session, engine), messages: [], signal: new AbortController().signal }, async () => {})
	assert.ok(checkpointOf(session))
})

test('單併發：工具空檔不啟動背景卡，agent 閒置後才啟動', async () => {
	const { engine, ctx } = ownedEngine()
	const session = working()
	const agent = scopedAgent(session, engine)
	await ctx.handlers.get('agent/pre-step')[0]({ agent, messages: [], signal: new AbortController().signal }, async () => {})
	assert.equal(engine.maybeStartBackground(session), undefined, '工具空檔')
	ctx.handlers.get('agent/status')[0]({ agent, status: 'idle' })
	await sleep(20)
	assert.equal(engine.state(session).cards.size, 1)
})

test('背景卡做完後再檢查一次，閒置時把未覆蓋的歷史做完', async () => {
	const { engine } = makeEngine()
	const session = working(12)
	await engine.maybeStartBackground(session)
	await sleep(50)
	assert.ok(engine.state(session).cards.size >= 2)
})

test('最小間隔擋下的檢查會延後補做', async () => {
	const { engine } = makeEngine({ config: { backgroundMinIntervalMs: 40 } })
	const session = working(12)
	await engine.maybeStartBackground(session)
	const after = engine.state(session).cards.size
	assert.equal(engine.maybeStartBackground(session), undefined)
	await sleep(120)
	assert.ok(engine.state(session).cards.size > after)
})

test('前景請求逾時：隔離期過後才重送，不在同一 slot 立刻送第二個', async () => {
	const { engine, model } = makeEngine({ config: { finalAttemptTimeoutMs: 30, quarantineMs: 80 } })
	const session = working()
	const starts = []
	const base = model.respond
	model.respond = (kind, request) => {
		starts.push(Date.now())
		if (kind === 'final' && starts.length === 1) {
			return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)))
		}
		return base(kind, request)
	}
	await engine.finalize(fakeAgent(session), AUTO)
	assert.equal(starts.length, 2)
	assert.ok(starts[1] - starts[0] >= 30 + 70, `第二次在 ${starts[1] - starts[0]}ms 後送出`)
})

test('/compact：commit 之後失敗回 commit；開鎖前的錯誤原樣拋出；摘要失敗回 summary', async () => {
	const failEnd = makeEngine()
	const session = working()
	session.turnEnd()
	const original = session.append.bind(session)
	session.append = (type, ...rest) => {
		if (type === 'compaction/end') throw new Error('disk full')
		return original(type, ...rest)
	}
	await assert.rejects(failEnd.engine.compactNow(fakeAgent(session), new AbortController().signal), (error) => error.code === 'commit')

	const open = makeEngine()
	const dangling = new FakeSession()
	dangling.user('go')
	dangling.assistant('call', [{}])
	await assert.rejects(open.engine.compactNow(fakeAgent(dangling), new AbortController().signal), (error) => error.code === undefined && /unanswered tool call/.test(error.message))

	const bad = makeEngine()
	bad.model.respond = () => { throw new Error('provider down') }
	const idle = working()
	idle.turnEnd()
	await assert.rejects(bad.engine.compactNow(fakeAgent(idle), new AbortController().signal), (error) => error.code === 'summary')
})

test('read_history：單一事件超過預算時，游標可續讀事件內剩餘內容', async () => {
	const { engine } = makeEngine({ config: { cardMaxSourceTokens: 100000 } })
	const session = working(1)
	const long = Array.from({ length: 600 }, (_, i) => `line${i}`).join(' ')
	session.assistant('one call', [{}])
	session.toolResult(long)
	await engine.finalize(fakeAgent(session), AUTO)
	const tool = createReadHistoryTool()
	const exec = { agent: { session } }
	const id = String(session.log.findIndex((event) => event.type === 'tool/result' && event.data.message.content[0].text === long))
	let cursor
	let text = ''
	for (let page = 0; page < 10; page += 1) {
		const out = await tool.execute({ id, max_output_tokens: 500, ...(cursor ? { cursor } : {}) }, exec)
		text += out.split(/---\n/).slice(1).join('---\n').replace(/\n\[event continues: pass next_cursor to read the rest\]$/, '')
		cursor = out.match(/next_cursor: (\S+)/)[1]
		if (cursor === 'none') break
	}
	assert.equal(cursor, 'none')
	assert.equal(text, long)
})

test('背景卡失敗後不在計時器上重送同一段；成功後才接著做下一段', async () => {
	const { engine, model } = makeEngine({ config: { backgroundMinIntervalMs: 10 } })
	const session = working(12)
	model.respond = () => { throw new Error('provider down') }
	await engine.maybeStartBackground(session)
	await sleep(60)
	assert.equal(model.calls.length, 1)
	assert.equal(engine.state(session).cards.size, 0)
})

test('agent/disposed：中止進行中的背景卡，之後不再為該 session 產卡', async () => {
	const { engine, ctx, model } = makeEngine()
	const session = working(12)
	let release
	model.respond = (kind, request) => new Promise((resolve, reject) => {
		release = resolve
		request.signal.addEventListener('abort', () => reject(request.signal.reason))
	})
	const job = engine.maybeStartBackground(session)
	await sleep(5)
	for (const handler of ctx.handlers.get('agent/disposed')) handler({ agent: fakeAgent(session) })
	await job
	assert.equal(engine.state(session).cards.size, 0)
	assert.equal(engine.maybeStartBackground(session), undefined)
	void release
})

test('preset 與 root 各掛一份：read_history 已註冊時共用，不讓第二份掛載失敗；其他註冊錯誤照常拋出', () => {
	const names = new Set()
	const tools = {
		register(tool) {
			if (names.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`)
			names.add(tool.name)
			return () => names.delete(tool.name)
		},
	}
	const first = makeEngine()
	first.ctx.tools = tools
	first.engine.registerReadHistory()
	const second = makeEngine()
	second.ctx.tools = tools
	assert.doesNotThrow(() => second.engine.registerReadHistory())
	assert.equal(names.size, 1)
	second.ctx.tools = { register() { throw new TypeError('tool "x" must declare output { schema, render, presentationMeta? }') } }
	assert.throws(() => second.engine.registerReadHistory(), /must declare output/)
})

// --- slow local providers (session d9e46833: 27B on llama.cpp hit the 90 s cap) ---

test('慢但持續輸出的請求：每個 chunk 重設閒置計時，不因總長短的閒置上限中止', async () => {
	const { engine, model } = makeEngine({ config: { attemptIdleTimeoutMs: 60, finalAttemptTimeoutMs: 5000, backgroundAttemptTimeoutMs: 5000 } })
	const session = working()
	const base = model.respond
	model.respond = async (kind, request) => {
		for (let i = 0; i < 6; i += 1) {
			await sleep(25)
			request.onProgress?.()
		}
		request.signal?.throwIfAborted()
		return base(kind, request)
	}
	await engine.finalize(fakeAgent(session), AUTO)
	assert.ok(checkpointOf(session), '總耗時超過閒置上限仍完成')
})

test('完全沒有輸出：以逾時錯誤結束，訊息寫明原因與設定鍵，不是 Request was aborted', async () => {
	const { engine, model } = makeEngine({ config: { attemptIdleTimeoutMs: 40, maxAttemptsPerRequest: 1 } })
	const session = working()
	model.respond = (kind, request) => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('Request was aborted'))))
	const before = session.nodes.length
	await assert.rejects(engine.finalize(fakeAgent(session), AUTO), /timed out: no output for .*attemptIdleTimeoutMs/)
	assert.equal(session.nodes.length, before, '主線不變')
})

test('BLOCKED 後接近視窗上限：再試最後一次而不是放任 overflow；成功後解除 BLOCKED', async () => {
	const { engine, model } = makeEngine({ ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } })
	const session = working(20, 1200)
	const base = model.respond
	model.respond = () => { throw new Error('provider down') }
	const agent = fakeAgent(session)
	await assert.rejects(engine.pressure(agent, undefined, 0))
	session.step('grow', 2000)
	await assert.rejects(engine.pressure(agent, undefined, 0))
	assert.equal(engine.state(session).blocked, true)
	const limits = await engine.limitsFor(session.requestHeader())
	assert.ok(limits.lastResortAt > limits.finalizeAt)
	// Retries stay spaced by retryAfterTokens; grow past both thresholds.
	const floor = Math.max(limits.lastResortAt, engine.state(session).retryAfterTokens)
	while (engine.ctx.tokenMeter.measure(session).totalTokens < floor) session.step('grow', 2000)
	model.respond = base
	const calls = model.calls.length
	const result = await engine.pressure(agent, undefined, 0)
	assert.ok(result, '最後一次成功')
	assert.ok(model.calls.length > calls)
	assert.equal(engine.state(session).blocked, false)
})

// --- /cards command --------------------------------------------------------------------

test('/cards：列出背景卡與狀態；別的 compaction 擁有時說明未啟用；重複註冊共用', async () => {
	const commands = new Map()
	const registry = {
		register(definition) {
			if (commands.has(definition.name)) throw new Error(`command "${definition.name}" is already registered in this scope`)
			commands.set(definition.name, definition)
			return () => commands.delete(definition.name)
		},
	}
	const { engine, ctx } = makeEngine()
	ctx.commands = registry
	engine.registerCommand()
	const second = makeEngine()
	second.ctx.commands = registry
	assert.doesNotThrow(() => second.engine.registerCommand())

	const session = working(12)
	await engine.maybeStartBackground(session)
	const handler = commands.get('cards').handler
	const text = (await handler({ agent: fakeAgent(session), signal: new AbortController().signal })).text
	assert.match(text, /cards-compaction: idle/)
	assert.match(text, /Background cards: 1 ready/)
	assert.match(text, /- c\d+-\d+ · seqs /)

	const foreign = ownedEngine()
	foreign.ctx.commands = new Map() && { register: (definition) => { foreign.handler = definition.handler; return () => {} } }
	foreign.engine.registerCommand()
	const agent = scopedAgent(working(), foreign.engine, { compactor: {} })
	assert.match((await foreign.handler({ agent })).text, /inactive for this agent/)
})

test('finalize 採用背景卡後，store 也移除；重啟不會把已採用的卡列成 stale', async () => {
	const { engine, store } = makeEngine()
	const session = working(12)
	await engine.maybeStartBackground(session)
	await sleep(5)
	assert.ok(store.load(session.id).length > 0)
	await engine.finalize(fakeAgent(session), AUTO)
	await sleep(5)
	assert.equal(store.load(session.id).length, 0)
	const restarted = new CardsCompactor(fakeContext(), TEST_CONFIG, { limiter: new QuotaLimiter({ capacity: 1, quarantineMs: 0 }), generate: new FakeModel().generate, store })
	assert.equal(restarted.state(session).cards.size, 0)
})

test('重啟時來源已被改寫的卡不載入', async () => {
	const { engine, store } = makeEngine()
	const session = working()
	await engine.maybeStartBackground(session)
	await sleep(5)
	const [stored] = store.load(session.id)
	store.table.records.set(session.id, { v: 1, updatedAt: 1, cards: [{ ...stored, digest: 'changed' }] })
	const restarted = new CardsCompactor(fakeContext(), TEST_CONFIG, { limiter: new QuotaLimiter({ capacity: 1, quarantineMs: 0 }), generate: new FakeModel().generate, store })
	assert.equal(restarted.state(session).cards.size, 0)
})

test('補卡被截斷：上限加倍重試、不耗用重試次數，之後的卡沿用加大的上限', async () => {
	const { engine, model } = makeEngine()
	const session = working(12)
	const respond = model.respond
	model.respond = (kind, request) => {
		if (kind === 'card' && request.maxTokens < 1000) throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' })
		return respond(kind, request)
	}
	await engine.finalize(fakeAgent(session), AUTO)
	const caps = model.calls.filter((call) => call.kind === 'card').map((call) => call.maxTokens)
	assert.deepEqual(caps.slice(0, 2), [500, 1000])
	assert.ok(caps.slice(2).every((cap) => cap === 1000), JSON.stringify(caps))
	assert.equal(engine.state(session).cardCap, 1000)
})

test('上限不超過 finalMaxOutputTokens 與 context 剩餘空間；最後一步截斷不再用同一上限重試', async () => {
	const { engine, model, ctx } = makeEngine()
	const session = working()
	const respond = model.respond
	model.respond = (kind, request) => {
		if (kind === 'final') throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' })
		return respond(kind, request)
	}
	await assert.rejects(engine.finalize(fakeAgent(session), AUTO), /truncated/)
	assert.deepEqual(model.calls.filter((call) => call.kind === 'final').map((call) => call.maxTokens), [1000])

	const b = makeEngine()
	b.model.respond = model.respond
	const other = working()
	const window = b.ctx.tokenMeter.measure(other).totalTokens + 2048 + 900
	await assert.rejects(b.engine.finalize(fakeAgent(other), { ...AUTO, limits: { target: 100000, window } }), /truncated/)
	const caps = b.model.calls.filter((call) => call.kind === 'final').map((call) => call.maxTokens)
	assert.equal(caps.length, 1, '被 room 壓低的最後一步也不加倍')
	assert.ok(caps[0] < 1000 && caps[0] >= 500, String(caps))
	assert.ok(ctx)
})

test('背景卡被截斷：記 warn，下一張背景卡用加倍的上限', async () => {
	const { engine, model, ctx } = makeEngine()
	const session = working(12)
	model.respond = (kind, request) => {
		if (request.maxTokens < 1000) throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' })
		return 'card body'
	}
	await engine.maybeStartBackground(session)
	await sleep(5)
	assert.equal(engine.state(session).cardCap, 1000)
	assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /next card cap 1000/.test(message)), JSON.stringify(ctx.logs))
	engine.state(session).lastBackgroundAt = 0
	await engine.maybeStartBackground(session)
	await sleep(5)
	assert.equal(model.calls.at(-1).maxTokens, 1000)
	assert.ok(engine.state(session).cards.size > 0)
})

const overflowConfig = { ctxOptions: { contextWindow: 6000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 300 } }
const overflowFailure = { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'prepared prompt exceeds max_context' }

test('context overflow：壓縮放得下的最長前段、保留其餘原文，回 retry；BLOCKED 時也照做', async () => {
	const { engine, ctx } = makeEngine(overflowConfig)
	const session = working(20, 1200)
	engine.state(session).blocked = true
	const total = ctx.tokenMeter.measure(session).totalTokens
	assert.ok(total > 6000, `fixture overflows (${total})`)
	const [onError] = ctx.handlers.get('agent/request-error')
	let passed = false
	const action = await onError({ agent: fakeAgent(session), failure: overflowFailure, signal: new AbortController().signal }, async () => { passed = true })
	assert.deepEqual(action, { kind: 'retry' })
	assert.equal(passed, false)
	assert.equal(engine.state(session).blocked, false)
	assert.ok(session.nodes.length > 2, '尾段保留原文')
	assert.ok(ctx.tokenMeter.measure(session).totalTokens < 6000)
})

test('context overflow：同一串只救一次；模型回覆後重置；其他錯誤與不擁有的 agent 不處理', async () => {
	const { engine, ctx, model } = makeEngine(overflowConfig)
	const [onError] = ctx.handlers.get('agent/request-error')
	const signal = new AbortController().signal
	const session = working(20, 1200)
	model.respond = () => { throw new Error('provider down') }
	let passed = 0
	const next = async () => { passed += 1 }
	assert.equal(await onError({ agent: fakeAgent(session), failure: overflowFailure, signal }, next), undefined)
	assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /overflow recovery failed/.test(message)))
	const calls = model.calls.length
	await onError({ agent: fakeAgent(session), failure: overflowFailure, signal }, next)
	assert.equal(model.calls.length, calls, '第二次不再嘗試')
	for (const handler of ctx.handlers.get('session/event')) handler(session, { type: 'assistant/message', seq: 999, data: {} })
	await onError({ agent: fakeAgent(session), failure: overflowFailure, signal }, next)
	assert.ok(model.calls.length > calls, '模型回覆後可以再救')

	const before = model.calls.length
	await onError({ agent: fakeAgent(working(20, 1200)), failure: { code: 'RATE_LIMITED' }, signal }, next)
	assert.equal(model.calls.length, before)
	assert.equal(passed, 4)
})

test("context overflow：補救失敗後 agent 閒置就重置，下一次 overflow 還能再救", async () => {
	const { ctx, model } = makeEngine(overflowConfig)
	const [onError] = ctx.handlers.get("agent/request-error")
	const [onStatus] = ctx.handlers.get("agent/status")
	const signal = new AbortController().signal
	const session = working(20, 1200)
	const agent = fakeAgent(session)
	const respond = model.respond
	model.respond = () => { throw new Error("provider down") }
	await onError({ agent, failure: overflowFailure, signal }, async () => {})
	const calls = model.calls.length
	onStatus({ agent, status: "idle" })
	model.respond = respond
	assert.deepEqual(await onError({ agent, failure: overflowFailure, signal }, async () => {}), { kind: "retry" })
	assert.ok(model.calls.length > calls)
})

test('context overflow：補救時最後一步與卡片的上限都不超過視窗 1/8', async () => {
	const { ctx, model, engine } = makeEngine({ ctxOptions: { contextWindow: 16000, defaultMaxTokens: 500 }, config: { nextStepReserveTokens: 200, finalMaxOutputTokens: 32768, cardMaxOutputTokens: 500 } })
	const session = working(40, 1200)
	engine.state(session).cardCap = 32768
	const [onError] = ctx.handlers.get('agent/request-error')
	await onError({ agent: fakeAgent(session), failure: overflowFailure, signal: new AbortController().signal }, async () => {})
	const caps = model.calls.map((call) => [call.kind, call.maxTokens])
	assert.ok(caps.length > 0)
	assert.ok(caps.every(([, cap]) => cap <= 2000), JSON.stringify(caps))
})

test('context overflow：自動 finalize 因預留而停用的小視窗，補救照樣可以做', async () => {
	const { ctx, engine } = makeEngine({ ctxOptions: { contextWindow: 32768, defaultMaxTokens: 16384 }, config: { nextStepReserveTokens: 16384, finalMaxOutputTokens: 32768, cardMaxOutputTokens: 4096 } })
	const session = working(80, 2400)
	assert.ok(ctx.tokenMeter.measure(session).totalTokens > 32768)
	assert.ok((await engine.limitsFor(session.requestHeader(), undefined)).infeasible)
	const [onError] = ctx.handlers.get('agent/request-error')
	const action = await onError({ agent: fakeAgent(session), failure: overflowFailure, signal: new AbortController().signal }, async () => {})
	assert.deepEqual(action, { kind: 'retry' })
})

test('context overflow：壓縮後仍超過視窗就保留壓縮、不重送', async () => {
	const { ctx } = makeEngine(overflowConfig)
	const session = working(20, 1200)
	session.step('huge tool output', 9000)
	const [onError] = ctx.handlers.get('agent/request-error')
	let passed = false
	const action = await onError({ agent: fakeAgent(session), failure: overflowFailure, signal: new AbortController().signal }, async () => { passed = true })
	assert.equal(action, undefined)
	assert.equal(passed, true)
	assert.ok(ctx.logs.some(([level, message]) => level === 'warn' && /not retrying/.test(message)), JSON.stringify(ctx.logs.slice(-3)))
})
