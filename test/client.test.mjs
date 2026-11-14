/**
 * client.js runs inside the App's module loader. These tests load the same
 * file in a vm with a stub loader and a minimal React, then drive the pure
 * projection and the row component.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { renderCheckpoint } from '../lib/checkpoint.js'

/** Minimal React: one component render with persistent state per call site. */
function fakeReact() {
	const states = []
	let cursor = 0
	const effects = []
	return {
		reset() { cursor = 0 },
		effects,
		createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
		useState(initial) {
			const index = cursor++
			if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
			return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
		},
		useEffect(fn) { effects.push(fn) },
	}
}

function loadClient() {
	const React = fakeReact()
	let plugin
	const sandbox = {
		window: { __ModuleLoader__: { load: ({ id, factory }) => { plugin = { id, ...factory((name) => (name === 'react' ? React : undefined)) } } } },
		setInterval, clearInterval, Date,
	}
	vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox)
	return { plugin, React }
}

/** Flatten a rendered tree to its text, rendering nested function components. */
function textOf(node, React) {
	if (node === null || node === undefined || node === false) return ''
	if (typeof node === 'string' || typeof node === 'number') return String(node)
	if (Array.isArray(node)) return node.map((child) => textOf(child, React)).join(' ')
	if (typeof node.type === 'function') return textOf(node.type(node.props), React)
	return textOf(node.props.children, React)
}

function findButton(node) {
	if (!node || typeof node !== 'object') return undefined
	if (Array.isArray(node)) return node.map(findButton).find(Boolean)
	if (node.type === 'button') return node
	return findButton(node.props?.children)
}

const t = (key, params = {}) => `${key}${Object.entries(params).map(([k, v]) => ` ${k}=${v}`).join('')}`

const event = (type, seq, data, time = 1000 + seq) => ({ type, seq, time, data })

const CHECKPOINT = renderCheckpoint({
	cards: [
		{ id: 'c3-9', seqs: [3, 4, 5, 6, 7, 8, 9], depth: 0, body: 'ran npm test\nresult: 2 failures in </card> parser' },
		{ id: 'a10-20', seqs: [10, 11, 12, 20], depth: 1, body: 'archive of earlier work' },
	],
	overview: '## Goal\nship the importer',
})

test('client：id 等於套件名；manifest 宣告 client 入口與 inject', () => {
	const { plugin } = loadClient()
	assert.equal(plugin.id, 'dsh-cards-compaction')
	assert.equal(plugin.name, 'dsh-cards-compaction')
	assert.deepEqual([...plugin.inject], ['slots', 'locale', 'uiConversation'])
	const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
	assert.equal(pkg.exports['./client'], './client.js')
	assert.ok(pkg.files.includes('client.js'))
	for (const name of ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-locale']) {
		assert.ok(pkg.dsh.client.inject.includes(name), name)
	}
})

test('client：中英字典鍵完全一致', () => {
	const { plugin } = loadClient()
	assert.deepEqual(Object.keys(plugin.internals.ZH).sort(), Object.keys(plugin.internals.EN).sort())
})

test('client：解析 renderCheckpoint 的輸出，還原跳脫、算出事件數', () => {
	const { plugin } = loadClient()
	const parsed = plugin.internals.parseCheckpoint(CHECKPOINT)
	assert.equal(JSON.stringify(parsed.cards.map((card) => [card.id, card.seqs, card.events, card.depth])), JSON.stringify([['c3-9', '3-9', 7, 0], ['a10-20', '10-12,20', 4, 1]]))
	assert.match(parsed.cards[0].body, /in <\/card> parser/)
	assert.equal(parsed.overview, '## Goal\nship the importer')
	assert.equal(plugin.internals.parseCheckpoint('This conversation summary is from compaction-basic.'), undefined)
})

test('client：只認 compaction 生命週期事件，以 compactionId 為 id', () => {
	const { plugin } = loadClient()
	const { matchEvent } = plugin.internals
	assert.deepEqual({ ...matchEvent(event('compaction/start', 5, { compactionId: 'x' })) }, { id: 'x', role: 'start' })
	assert.deepEqual({ ...matchEvent(event('compaction/end', 9, { compactionId: 'x' })) }, { id: 'x', role: 'update' })
	assert.equal(matchEvent(event('compaction/start', 5, {})), null)
	assert.equal(matchEvent(event('user/message', 5, { compactionId: 'x' })), null)
})

test('client：進行中 → 成功顯示卡片；別的 backend 的成功不顯示；自動失敗顯示原因；手動失敗交給指令列', () => {
	const { plugin } = loadClient()
	const { fold, rowOf } = plugin.internals
	const started = fold(undefined, event('compaction/start', 5, { compactionId: 'x', turn: 1 }))
	assert.equal(rowOf(started).status, 'running')

	const summarized = fold(started, event('compaction/summary', 6, { compactionId: 'x', summary: [{ type: 'text', text: CHECKPOINT }], shadowedSeqs: [1, 2, 3], shadowedTokenCount: 900 }))
	const done = rowOf(fold(summarized, event('compaction/end', 8, { compactionId: 'x' })))
	assert.equal(done.status, 'done')
	assert.equal(done.cards.length, 2)
	assert.equal(done.replacedEvents, 3)
	assert.equal(done.replacedTokens, 900)

	const basic = fold(started, event('compaction/summary', 6, { compactionId: 'x', summary: [{ type: 'text', text: 'plain summary' }] }))
	assert.equal(rowOf(fold(basic, event('compaction/end', 8, { compactionId: 'x' }))), null)

	const failed = rowOf(fold(started, event('compaction/end', 8, { compactionId: 'x', error: 'foreground request timed out: no output for 180s' })))
	assert.deepEqual({ ...failed }, { status: 'failed', error: 'foreground request timed out: no output for 180s' })

	const manual = fold(undefined, event('compaction/start', 5, { compactionId: 'y', sourceCommandId: 'cmd', turn: null }))
	assert.equal(rowOf(manual), null, '手動 /compact 進行中交給指令卡')
	const manualDone = fold(fold(manual, event('compaction/summary', 6, { compactionId: 'y', sourceCommandId: 'cmd', summary: [{ type: 'text', text: CHECKPOINT }] })), event('compaction/end', 7, { compactionId: 'y', sourceCommandId: 'cmd' }))
	assert.equal(rowOf(manualDone), null, '手動成功也交給指令卡')
	assert.equal(rowOf(fold(manual, event('compaction/end', 6, { compactionId: 'y', sourceCommandId: 'cmd', error: 'x' }))), null)
	assert.equal(rowOf(fold(undefined, event('compaction/end', 8, { compactionId: 'z', error: [{ name: 'Error', message: 'chain' }] }))).error, 'chain')
})

test('client：Definition 產生 chat node，kind 對應 renderer key，放在 start 之後', () => {
	const { plugin } = loadClient()
	const { definition } = plugin.internals
	const start = event('compaction/start', 5, { compactionId: 'x' })
	const state = definition.start({}, { event: start })
	const node = definition.buildViewNode({ key: 'k', id: 'x', state, start: { location: { kind: 'turn' } }, matches: [] })
	assert.equal(node.kind, 'cards-compaction')
	assert.equal(node.target, 'chat')
	assert.equal(node.anchorSeq, 5.05)
	assert.deepEqual({ ...node.location }, { kind: 'turn' })
})

test('client：成功列可展開，展開後列出每張卡、overview 與 read_history 提示', () => {
	const { plugin, React } = loadClient()
	const { fold, rowOf, CardsRow } = plugin.internals
	let state = fold(undefined, event('compaction/start', 5, { compactionId: 'x' }))
	state = fold(state, event('compaction/summary', 6, { compactionId: 'x', summary: [{ type: 'text', text: CHECKPOINT }], shadowedSeqs: [1, 2], shadowedTokenCount: 50 }))
	state = fold(state, event('compaction/end', 7, { compactionId: 'x' }))
	const props = { node: { data: rowOf(state) }, t }
	React.reset()
	const collapsed = CardsRow(props)
	assert.match(textOf(collapsed, React), /title\.done summary\.done cards=2 events=2 tokens=50/)
	assert.doesNotMatch(textOf(collapsed, React), /ran npm test/)
	findButton(collapsed).props.onClick()
	React.reset()
	const expanded = textOf(CardsRow(props), React)
	assert.match(expanded, /c3-9 card\.meta seqs=3-9 events=7/)
	assert.match(expanded, /card\.archive depth=1/)
	assert.match(expanded, /ran npm test/)
	assert.match(expanded, /ship the importer/)
	assert.match(expanded, /hint\.done/)
})

test('client：進行中列不可展開並顯示經過時間；失敗列展開看完整錯誤', () => {
	const { plugin, React } = loadClient()
	const { CardsRow, formatElapsed } = plugin.internals
	assert.equal(formatElapsed(65_000), '1m 5s')
	React.reset()
	const running = CardsRow({ node: { data: { status: 'running', startTime: Date.now() - 3000 } }, t })
	assert.equal(findButton(running).props.disabled, true)
	assert.match(textOf(running, React), /summary\.running elapsed=3s/)

	const failedProps = { node: { data: { status: 'failed', error: 'timed out: no output for 180s' } }, t }
	React.reset()
	findButton(CardsRow(failedProps)).props.onClick()
	React.reset()
	assert.match(textOf(CardsRow(failedProps), React), /timed out: no output for 180s .*hint\.failed/)
})

test('client：apply 註冊字典、Definition 與 chat node renderer', () => {
	const { plugin } = loadClient()
	const calls = []
	const ctx = {
		effect: (fn, label) => calls.push(['effect', label, fn()]),
		locale: { register: (ns, dicts) => { calls.push(['locale', ns, Object.keys(dicts)]); return () => {} } },
		uiConversation: { events: { register: (definition) => { calls.push(['definition', definition.kind]); return () => {} } } },
		slots: {
			inject: (name, fn) => calls.push(['inject', name, fn()]),
			register: (options, component) => ({ ...options, component: component.name }),
		},
	}
	plugin.apply(ctx)
	assert.ok(calls.some(([kind, ns, langs]) => kind === 'locale' && ns === 'cards-compaction' && langs.join() === 'en,zh'))
	assert.ok(calls.some(([kind, name]) => kind === 'definition' && name === 'cards-compaction-lifecycle'))
	const slot = calls.find(([kind]) => kind === 'inject')
	assert.equal(slot[1], 'conversation.chat.node')
	assert.equal(slot[2].key, 'cards-compaction')
	assert.equal(slot[2].component, 'CardsRow')
})
