# 明確非目標

這個檔案曾經是完整 PRD（逆向自 `fhir-gateway` v0.5.0 的 Java 版，分 Phase 0–9 追蹤實作
狀態）。**那份文件已經停止維護，於是變成沉積層**：spec #1（IdP-agnostic identity layer）與
部分章節被加上註解、部分章節仍在講舊世界。半準半誤的文件比沒有更糟。

現在只保留**仍然為真的部分**。其餘內容的正確來源：

| 想知道的 | 去哪裡 |
| --- | --- |
| 這個 gateway 是什麼、怎麼跑、怎麼設定 | `README.md` |
| 詞彙（launch context、trust path、tenant boundary…） | `CONTEXT.md` |
| 為什麼是這個架構 | `docs/adr/` |
| 模組邊界與隱藏耦合 | `docs/agents/codebase-map.md` |
| 正在做什麼、為什麼 | GitHub Issues（`gh issue list`） |
| 改了什麼、測試在哪 | `git log` |

## V1 不實作（與原始 SPEC 一致）

- **Query Rewrite** — 不改寫請求中的查詢語意。
- **Response security label 全面過濫** — 不過濾回應中的 security label。
- **Reverse chaining**（`_has`）**維持封鎖** — 連同 `_include` / `_revinclude` 與以 `.` 連續的
  chaining 參數一起封鎖，理由是它們能繞過 patient context（見 `src/constants/fhir.ts`）。
- **Bundle `batch`** — 不支援 transaction bundle。
- **FHIR 版本可配置** — 硬編碼 R4。
- **ES256 等額外 JWT 演算法** — 只接受 RS256（見 `src/constants/auth.ts`）。

## 已從非目標移出的項目

- ~~**JWKS 標準 endpoint**（原註記「維持 Keycloak `public_key`」）~~ — **已實作，且是預設
  路徑**。spec #1（issue #2）之後 `SIGNING_KEY_SOURCE` 預設為 `auto`：先走 OIDC discovery 的
  `jwks_uri`，取不到才退回 Keycloak 專屬的 `public_key` adapter。舊部署不需改設定。
