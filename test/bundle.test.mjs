import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { Config, apply, inject, name } from '../lib/index.js'
import { CardsCompactionEngine, CardsCompactor } from '../lib/engine.js'
import { READ_HISTORY } from '../lib/tools.js'
import { fakeContext } from './helpers.mjs'

test('入口宣告 identity；engine 自己宣告要的 service', () => {
	assert.equal(name, 'dsh-cards-compaction')
	assert.deepEqual(inject, [])
	assert.deepEqual(CardsCompactionEngine.inject, ['llm', 'tokenMeter', 'sessions', 'tools'])
})

test('apply()：以子 plugin 掛上 engine，並把驗證後的 config 傳下去', () => {
	const mounted = []
	const config = Config['~standard'].validate({}).value
	apply({ plugin: (plugin, value) => mounted.push([plugin, value]) }, config, { real: true })
	assert.deepEqual(mounted, [[CardsCompactionEngine, config]])
})

test('apply()：沒有 host 套件時拒絕載入，不默默以無 compaction 的狀態運作', () => {
	const mounted = []
	assert.throws(() => apply({ plugin: (plugin) => mounted.push(plugin) }, {}, { real: false }), /host packages/)
	assert.equal(mounted.length, 0)
})

test('engine 建構：註冊 read_history 與 pre-step、request、背景事件 hook', () => {
	const ctx = fakeContext()
	const engine = new CardsCompactionEngine(ctx, {})
	assert.ok(engine.compactor instanceof CardsCompactor)
	for (const method of ['compactIfNeeded', 'compactRegion', 'compactNow']) assert.equal(typeof engine[method], 'function', method)
	assert.deepEqual(ctx.registered.map((tool) => tool.name), [READ_HISTORY])
	for (const event of ['agent/pre-step', 'agent/request', 'agent/request-error', 'agent/status', 'session/event']) {
		assert.ok(ctx.handlers.has(event), event)
	}
	engine.compactor.dispose()
})

test('auto 與 background 關閉時不掛對應 hook', () => {
	const ctx = fakeContext()
	new CardsCompactionEngine(ctx, { auto: false, background: false })
	assert.ok(!ctx.handlers.has('agent/pre-step'))
	assert.ok(!ctx.handlers.has('session/event'))
	assert.ok(ctx.handlers.has('agent/request'), '仍追蹤主線推論，供配額判斷')
})

test('壞 config 讓 engine 建構失敗，不靜默用預設', () => {
	assert.throws(() => new CardsCompactionEngine(fakeContext(), { cardMinSourceTokens: -1 }), /cardMinSourceTokens/)
})

test('patch：停用內建 compaction-basic 並插入本 bundle，只有一個 compaction owner', () => {
	const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
	assert.match(patch, /- id: compaction-basic\n\s+name: '@deepseek-ai\/dsh-compaction-basic'\n\s+disabled: true/)
	assert.match(patch, /- insert:\n\s+- id: cards-compaction\n\s+name: dsh-cards-compaction/)
})
