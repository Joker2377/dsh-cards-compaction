/**
 * dsh-cards-compaction — 背景產生歷史 cards，正式 compact 時以完整主線 context
 * 產生尾段 card 與整體摘要，驗證後一次替換。規格見 docs/spec.md。
 *
 * 目前是骨架：compaction provider 的接點要等階段 0 確認 host 契約後才接上。
 */
import { createReadHistoryTool } from './tools.js'

export const name = 'dsh-cards-compaction'

/** 需要工具註冊表，ctx.tools.register() 才存在。 */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
	ctx.tools.register(createReadHistoryTool())
}
