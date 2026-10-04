# Launch context 歸 gateway 所有，且需要 gateway 參與 authorization flow

評估把 SMART launch context（patient／encounter 參考）放在哪裡。**決定由 gateway 自己持有並寫入 Valkey；context 不進 access token。** 這條決策的後果是 gateway 必須參與 authorization flow 成為 BFF 代理。

## 為什麼不在 token 裡

原本的設計是「context 進 token，IdP 用 hook 回填」（Keycloak protocol mapper／Logto `getCustomJwtClaims` script／Casdoor JWT-Custom）。評估過程中發現一個物理限制：

**gateway 對 IdP 簽出的 token 有零寫入權。** 要讓 context 進 token，必然需要 IdP 端存在一個寫入點——而那正是 `keycloak-smart-fhir` 這個 SPI 做的事。換句話說「context 進 token」在非 IdP 端寫入的前提下不可行；若堅持走 IdP 寫入，就是回到那個要消滅的第三方 jar。

**跨 IdP 最低公分母極低。** 查證三家的實際能力：

| | `sid` 在 access token | refresh 穩定 | 結論 |
|---|---|---|---|
| Keycloak | ✅（`TokenManager.initToken()`） | ✅ | 可行 |
| Logto | ⚠️ 底層有、官方文件未承諾 | 推測 | 不可依賴 |
| Casdoor | ❌ `Claims` struct 無 `sid` | 不適用 | 不可行 |

三家都保證的是 `sub` + `azp`／`client_id`。**因此 context 的索引鍵定為 `(subject, client id)`，生命週期由 gateway 自管。**

## 為什麼 gateway 必須進 authorization flow

這是評估中被漏掉、後來才發現的關鍵：**context 無法只靠「store lookup」綁到使用者。**

流程走一遍：EHR 建立 context（gateway 知道 `launch id → patient X`）→ App 發 `authorize?launch=<id>` → 使用者在 **IdP** 登入（IdP 知道 `sub`，但不知道 patient X）→ IdP 發 token（token 裡沒有 patient）→ App 帶 token 呼叫 gateway（gateway 知道 `sub`，但**不知道它對應哪個病人**）。

**`launch id` 與 `sub` 第一次同時存在的時刻，是使用者完成認證的那一瞬間——而那發生在 IdP 的 auth flow 裡，gateway 不在場。** 建立這條連結的唯一時機就在那裡。

這正是 `EhrLaunchContextResolver` 存在的唯一理由：那個 SPI 不是功能外掛，是結構必需品。SMART 規格也把「解析 launch → patient」定為 AS 的責任。

**因此 gateway 代理 `/authorize`：轉發請求（保留 `launch id` 與 `state`），callback 回來時用 code 換 token，`sub` 與 `launch id` 同時在手 → 寫入 store 完成綁定 → 再把 token 交給 App。gateway 不簽任何東西（見 ADR-0001）。** Proxy Smart 的 `/auth/authorize|token` 就是這個形狀。

**correlate token 用 `launch id` 本身**，不引入 cookie session——它由 gateway 生成、單次可用，天然就是 correlate token。

## Consequences

- **`LaunchContext` DTO 的形狀不變**。今天 `src/types/launch-context.ts` 的欄位（`subject`／`scopes`／`patientId`／`patientListId`／`authorizedParty`／`tokenId`／`display`）正是「授權輸入的 DTO」，不是「claim 的容器」。**只有填入它的函式從「讀 token claim」換成「查 store」，介面不變。** spec #1 的 ticket #3／#6／#7 因此仍然成立。
- gateway 第一次進入 authorization flow。`redirect_uri` 白名單、state／nonce 處理、`online_access` 的 session 語意都是全新議題。
- **遷移期不支援雙 IdP 並存**。gateway 在 auth flow 裡，同時代理兩個 IdP 會讓授權層複雜度倍增。改採停機切換——這是明確決定，不是遺漏。
- **稽核缺口擴大**：context 不在 token 裡代表 token 本身不含 PHI，「誰授權了這個醫師看這個病人」的唯一來源就是 gateway 記錄的 launch lifecycle 事件。這些事件目前**完全不存在**。