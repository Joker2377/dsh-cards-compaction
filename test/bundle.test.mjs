import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'
import { NotImplementedError, READ_HISTORY } from '../lib/tools.js'

/** 最小可用的假 ctx：只實作 apply() 真的會碰到的東西。 */
function fakeContext() {
	const registered = []
	return {
		registered,
		ctx: {
			tools: {
				register: (definition) => {
					registered.push(definition)
					return () => {}
				},
			},
		},
	}
}

test('外掛宣告了 DSH 需要的 identity 與 service', () => {
	assert.equal(name, 'dsh-cards-compaction')
	assert.deepEqual(inject, ['tools'])
})

test('apply()：註冊一個 read_history 工具', () => {
	const { ctx, registered } = fakeContext()
	apply(ctx)
	assert.deepEqual(registered.map((tool) => tool.name), [READ_HISTORY])
})

test('read_history：尚未實作時丟明確錯誤，不回空內容', async () => {
	const { ctx, registered } = fakeContext()
	apply(ctx)
	await assert.rejects(registered[0].execute({ id: 'card-1' }), NotImplementedError)
})
