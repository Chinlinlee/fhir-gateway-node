# AGENTS.md

Guidance for coding agents working in this repository.

## 工具鏈：不要用 `npx`

這兩條指令在這個 repo 會解析到**錯誤的執行檔**，而且不會報錯：

| 不要用 | 原因 | 改用 |
| --- | --- | --- |
| `npx tsc` | 解析到不相關的套件 | `pnpm run typecheck` |
| `npx biome` | 解析到全域的 **0.3.3**，而 repo pin 的是 **2.4.16**。0.3.3 對任何輸入都回報 0 errors，**包括故意寫壞的檔案** | `pnpm run lint` |

`pnpm run lint` 會直接呼叫 `node_modules/@biomejs/biome/bin/biome`，繞過 `.bin`（本 repo 的
`node_modules/.bin` 不存在）。

**不要相信「lint 是 clean 的」這種結論，除非你確認過用的是 repo 的版本。** 這不是假設——
本 repo 真的發生過：一次 merge 驗證因為用了 0.3.3 而回報 clean，而實際上有問題。

驗證你用的是對的版本：

```bash
node node_modules/@biomejs/biome/bin/biome --version   # 應為 Version: 2.4.16
npx biome --version                                   # 危險：會印出 0.3.3
```

### 換行之類的假訊號

`.gitattributes` 已宣告 `eol=lf`。若你仍看到 biome 對幾乎每個檔案報 format error，
通常是工作區沒套用該設定——執行 `git add --renormalize .` 後重新 checkout。

### 檢查工具鏈本身

```bash
pnpm run verify   # typecheck + lint + test
```

## 測試

**預設的測試 seam 是「整個 app over HTTP」**：用 `createApp` 組出真實 app，配 stub IdP 與
stub FHIR upstream，用 `app.handle(new Request(...))` 驅動，斷言 status code 與 response。

**已知的例外是 launch context store 介面**（ADR-0002）：bind、依 access token 回讀、TTL 到期
這些行為在 gateway 進 authorization flow 之前無法經 HTTP 觀察，所以 store 介面是刻意保留的
第二個 seam。它的測試是窄測試，斷言 store 介面自己的行為而不是 HTTP 結果——這是例外，不是
可以隨手擴張的先例。新增 seam 前先更新 `tests/README.md`。

好的測試斷言可觀察行為。壞的測試斷言：某個 resolver 有被呼叫、某個 DTO 有某個欄位、
某個常數的字串值，或在只有 status code 有意義時去斷言錯誤訊息逐字相符。

**寫測試前先讀 `tests/README.md`** — 那裡列了全部 helpers（stub IdP、launch context fixture、
mock FHIR client 等）與各自的用途。多數情況不需要自己造 stub。

## Issue tracker

Issues 與 specs 存在本 repo 的 GitHub Issues，用 `gh` CLI 操作。細節見 `docs/agents/issue-tracker.md`。

## Domain docs

**先讀 `CONTEXT.md`** — 那是本 repo 的詞彙表，定義了 launch context、trust path、tenant boundary
等概念，並標明每個詞的 `_Avoid_` 別名。命名時用它，不要自造同義詞。

**`_Avoid_` 裡的禁用詞已經是機械檢查**：`pnpm run check:glossary`（已包含在 `pnpm run verify`
裡）會擋下它們出現在 `src/` 與 `tests/`。真的需要放行一個詞，改 `CONTEXT.md`，不要改檢查腳本。

接著讀 `docs/adr/` 裡與你正要動的區域相關的 ADR。**若你的改動與某份 ADR 衝突，明確提出來，
不要默默推翻它。**

詳細說明見 `docs/agents/domain.md`。

## Codebase map

**動工前先讀 `docs/agents/codebase-map.md`** — 模組邊界、`app.ts` 裡的條件式路由註冊與隱藏
耦合、錯誤到 status 的對應、以及新增設定項要動的四處。那裡的耦合（共用 store instance、
backend 建立的雙重條件）從檔名看不出來，grep 找不出來。

## 開發慣例

- 註解與文件用繁體中文（台灣慣用語）混英文技術詞，與既有程式碼一致。
- 授權裁決（access decision）、patient compartment 規則、allowed query 規則、AuditEvent 的
  輸出形狀——這些屬於 FHIR/SMART 語意，改動前先確認你真的需要改。
- 新增設定項時同步更新 `env.example`、`README.md` 的環境變數清單，以及專屬章節。