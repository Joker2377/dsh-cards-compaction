/**
 * dsh-cards-compaction 的工具定義。
 *
 * defineTool 在 DSH 內由 @deepseek-ai/dsh-tools 提供。脫離 App 直接跑測試時退回恆等
 * 實現，所以這個模組可以被純 node 匯入——npm test 不需要安裝任何依賴。
 *
 * read_history 是 spec §16 的原文查閱契約。階段 0 要先確認 host 既有的 session
 * history 查閱能力夠不夠；夠就不註冊這個工具。實作前一律回明確錯誤，不回空字串。
 */
const { defineTool } = await import('@deepseek-ai/dsh-tools')
	.catch(() => ({ defineTool: (definition) => definition }))

export const READ_HISTORY = 'cards_compaction_read_history'

export class NotImplementedError extends Error {
	constructor(what) {
		super(`${what} 尚未實作（見 docs/scope.md 的階段表）`)
		this.name = 'NotImplementedError'
	}
}

export function createReadHistoryTool() {
	return defineTool({
		name: READ_HISTORY,
		description: [
			'讀回被壓縮成 card 的原始 session 紀錄（命令、完整錯誤、程式碼、數值）。',
			'card 內容不足以安全行動時才呼叫。只能讀目前 session 與分支上的來源。',
			'回傳來源 ID、內容、完整性、digest；內容過長時分頁，用 next_cursor 續讀。',
		].join('\n'),
		parameters: {
			id: { type: 'string', description: 'card ID 或 source ID。' },
			cursor: { type: 'string', description: '上一頁回傳的 next_cursor。' },
			query: { type: 'string', description: '在來源內搜尋的文字。' },
			max_output_tokens: { type: 'number', description: '本次回傳的 token 上限。' },
		},
		isConcurrencySafe: () => true,
		async execute() {
			throw new NotImplementedError(READ_HISTORY)
		},
	})
}
