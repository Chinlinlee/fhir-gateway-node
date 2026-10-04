# Launch context 歸 gateway 所有，且需要 gateway 參與 authorization flow

評估把 SMART launch context（patient／encounter 參考）放在哪裡。**決定由 gateway 自己持有並寫入 store；context 不進 access token。** 這條決策的後果是 gateway 必須參與 authorization flow 成為 BFF 代理。

## 為什麼不在 token 裡

原本的設計是「context 進 token，IdP 用 hook 回填」（Keycloak protocol mapper／Logto `getCustomJwtClaims` script／Casdoor JWT-Custom）。評估過程中發現一個物理限制：

**gateway 對 IdP 簽出的 token 有零寫入權。** 要讓 context 進 token，必然需要 IdP 端存在一個寫入點——而那正是 `keycloak-smart-fhir` 這個 SPI 做的事。換句話說「context 進 token」在非 IdP 端寫入的前提下不可行；若堅持走 IdP 寫入，就是回到那個要消滅的第三方 jar。

**跨 IdP 最低公分母極低。** 查證三家的實際能力：

| | `sid` 在 access token | refresh 穩定 | 結論 |
|---|---|---|---|
| Keycloak | ✅（`TokenManager.initToken()`） | ✅ | 可行 |
| Logto | ⚠️ 底層有、官方文件未承諾 | 推測 | 不可依賴 |
| Casdoor | ❌ `Claims` struct 無 `sid` | 不適用 | 不可行 |

**因此 context 的生命週期由 gateway 自管。**

## 為什麼 gateway 必須進 authorization flow

這是評估中被漏掉、後來才發現的關鍵：**context 無法只靠「store lookup」綁到使用者。**

流程走一遍：EHR 建立 context（gateway 知道 `launch id → patient X`）→ App 發 `authorize?launch=<id>` → 使用者在 **IdP** 登入（IdP 知道 `sub`，但不知道 patient X）→ IdP 發 token（token 裡沒有 patient）→ App 帶 token 呼叫 gateway（gateway 知道 `sub`，但**不知道它對應哪個病人**）。

**`launch id` 與 `sub` 第一次同時存在的時刻，是使用者完成認證的那一瞬間——而那發生在 IdP 的 auth flow 裡，gateway 不在場。** 建立這條連結的唯一時機就在那裡。

這正是 `EhrLaunchContextResolver` 存在的唯一理由：那個 SPI 不是功能外掛，是結構必需品。SMART 規格也把「解析 launch → patient」定為 AS 的責任。

**因此 gateway 代理 `/authorize`：轉發請求（保留 `launch id` 與 `state`），callback 回來時用 code 換 token，`sub` 與 `launch id` 同時在手 → 寫入 store 完成綁定 → 再把 token 交給 App。gateway 不簽任何東西（見 ADR-0001）。**

**correlate token 用 `launch id` 本身**，不引入 cookie session——它由 gateway 生成、單次可用，天然就是 correlate token。

## 索引鍵：`azp` 撐不起來，改用 access token 自己的 `jti`

**這一節修正本 ADR 早期版本的一個錯誤假設，必須留下來否則會有人把它改回去。**

早期版本寫的是：「三家 IdP 都保證 `sub` + `azp`／`client_id`，**因此 context 的索引鍵定為 `(subject, client id)`**。」

**這個推論在 gateway 代理 authorization flow 的架構下不成立。** code exchange 是 **gateway** 拿自己的 client 憑證去做的，因此 IdP 簽出的 access token 裡：

| claim | 實際值 | 能否指出是哪個 App |
| --- | --- | --- |
| `azp` | **gateway 自己的** IdP client id | ❌ 所有 App 的 token 都一樣 |
| `aud` | FHIR 端點 | ❌ |
| `iss` | IdP | ❌ |
| `sub` | 醫師 | 只到人，不到這次 launch |
| `jti` | 這張 token 自己的識別碼 | ✅ 唯一 |

也就是說，**token 裡沒有任何欄位指出「這次授權屬於哪個 App」**。用 `(sub, azp)` 查 store 會查不到任何一筆這個流程寫進去的綁定——不是邊界情況，是每一筆都 miss。

**決定：綁定仍然以 `(subject, client id)` 為索引鍵（它是正確的授權事實），但 FHIR 請求時的查找路徑多一層——依 App 帶來的 access token 的 `jti` 找到它所屬的綁定。** 這個映射由 gateway 在**即將把 token 交給 App 的那一刻**寫入 store（token endpoint 的 `authorization_code` 與 `refresh_token` 兩種 grant 都寫），因此 gateway 永遠知道「我發出去的哪一張 token 屬於哪一次授權」。

為什麼不退回 `(subject, 單一 client id)` 之類較粗的鍵：**一位醫師同時開兩個 App、兩個不同病人是 EHR 的常態**，粗鍵會讓兩個 App 的請求互相命中對方的病人，而且錯得沒有任何徵兆。`jti` 是唯一能同時滿足「綁定精確」與「refresh 後仍然解析得到」的鍵。

**這條路徑對 IdP 有一個硬性要求：access token 必須帶 `jti`（RFC 7519 §4.1.7）。** 沒有 `jti` 的 token 沒有索引鍵，patient／list 模式會拿不到 launch context 而 401——**不會**退化成「沒有病人限制」。

## Consequences

- **`LaunchContext` DTO 的形狀不變**（`subject`／`patientId`／`patientListId`／`scopes`／`agent`）。**只有填入它的函式從「讀 token claim」換成「查 store」。** 但 `LaunchContextProvider.create` 變成非同步：讀 store 是 I/O，這個 interface 的回傳型別因此是 `Promise<LaunchContext>`。介面的名稱、方法、參數與 DTO 欄位都沒變，只有這一個非同步化。
- **只有 PHI 離開 token。** `scopes` 與 `agent`（`sub`、`azp`、`jti`、`iss`、顯示名稱）仍然從 verified token 讀：它們不是 PHI，而 scope 是 AS 的授權決定，gateway 去猜等於越權。**讀者不應假設整個 DTO 都來自 store。**
- **這是硬切，沒有後備。** store 查不到、context 已刪除、或 store 不可達時，`patientId`／`patientListId` 一律留空；patient／list 模式因此 401，**不會**退回讀 token 的 `patient` claim。Claim 名稱設定（`LAUNCH_CLAIM_NAMES`）裡的 `patient` 與 `patient_list` 已移除，授權層沒有任何地方再從 token 讀 PHI。
- **不需要 launch context 的路徑在 store 故障時照常服務**（scope 合併檢查、DEV permissive、allowed queries）。反過來說：store 故障對 patient／list 模式等同 401——填滿資料庫或維護窗口**絕不可**退化成靜態的越權開關。
- **launch context 的內容現在由 EHR 與 gateway 決定，不再依賴 IdP 發得出某個 claim。** 這順帶修掉 `ACCESS_CHECKER=list` 在文件記載的部署中永遠 401 的既有缺陷：EHR 建立 context 時指定 patient list，list 模式端到端可用。
- gateway 第一次進入 authorization flow。`redirect_uri` 白名單、state／nonce 處理、`online_access` 的 session 語意都是全新議題。
- **遷移期不支援雙 IdP 並存**。gateway 在 auth flow 裡，同時代理兩個 IdP 會讓授權層複雜度倍增。改採停機切換——這是明確決定，不是遺漏。
- **稽核缺口擴大**：context 不在 token 裡代表 token 本身不含 PHI，「誰授權了這個醫師看這個病人」的唯一來源就是 gateway 記錄的 launch lifecycle。context 的建立（EHR 註冊）、綁定（callback）與 access（每次 FHIR 請求）都已有實作，但**它們目前不會產生任何 AuditEvent**——Launch AuditEvent 尚未實作，因此這三件事在稽核軌跡裡不存在。這是本 ADR 承認的缺口，不是已完成的能力。
