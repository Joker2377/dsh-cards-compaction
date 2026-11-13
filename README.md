# dsh-cards-compaction

[![test](https://github.com/Joker2377/dsh-cards-compaction/actions/workflows/test.yml/badge.svg)](https://github.com/Joker2377/dsh-cards-compaction/actions/workflows/test.yml)

*Background history cards compaction for DeepSeek Harness.*

> [!NOTE]
> DeepSeek Harness bundle. Installs into a profile; it does not run on its own.

> [!WARNING]
> 開發中的骨架，尚無可用功能。規格見 [docs/spec.md](docs/spec.md)，進度見 [docs/scope.md](docs/scope.md)。

## 功能

- 工作期間在背景把舊歷史整理成精簡 cards，不改動主線 context。（未實作）
- 正式 compact 時讀完整主線，產生最後一張 card 與整體摘要，驗證後一次替換。（未實作）
- 原始 logs 另存，模型可用 `cards_compaction_read_history` 查回原文。（未實作）

## 安裝

在 DSH 裡貼：

```text
https://github.com/Joker2377/dsh-cards-compaction
```

> [!IMPORTANT]
> 貼倉庫**首頁**網址。`https://github.com/Joker2377/dsh-cards-compaction/tree/main` 這類頁面網址會被拒絕。

或用 CLI：`plugin_manager install_bundle`，spec 用 `github:Joker2377/dsh-cards-compaction`。

## 使用

尚未實作。完成後啟用即可，不需要手動操作；正常背景產卡不會插入聊天訊息。

## 疑難排解

| 症狀 | 原因 | 做法 |
| --- | --- | --- |
| `read_history` 回「尚未實作」 | 骨架版本 | 等階段 4 |

## 運作原理

見 [docs/spec.md](docs/spec.md) §1–§4：背景產卡只讀主線 prefix、不改主線；正式 compact 固定 cutoff snapshot，覆蓋與預算驗證全過才提交 checkpoint。

## 開發

```bash
node scripts/check.mjs
npm test              # DSH 桌面沙箱內用 npm run test:sandbox
```

測試只用 `node:` builtins 與 `lib/`，不需要 `npm install`。

## 已知限制

- 尚無功能；只確認骨架可被匯入與註冊。
- 尚未在真實 host 載入驗證。
- v1 不支援圖片、音訊與外部附件。

## 授權

MIT，見 [LICENSE](LICENSE)。
