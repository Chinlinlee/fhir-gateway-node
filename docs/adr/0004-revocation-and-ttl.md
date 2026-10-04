# Launch context 的續期靠 IdP session 存活性，撤銷延遲受 IdP 能力限制

Launch context 由 gateway 存於 Valkey（ADR-0002），因此它的生命週期由 gateway 管理。**決定用短 TTL 搭配「IdP session 是否仍存活」的定期檢查來續期，而非依賴 SMART App 的 refresh token。**

## 為什麼不能靠 refresh token 續期

原本考慮「短 TTL + app 帶著 refresh token 續期」。這在 EHR launch 語意下不成立：**EHR launch 使用 `online_access` scope，其定義就是 refresh token 只在使用者線上時有效、瀏覽器關閉即失效。**

而「醫師花 4 小時處理同一個病人」恰恰是最可能沒有持續 refresh 的情境——他離開螢幕去開會，app 沒在跑，context 到期，回來時拿舊 token 呼叫會得到 401。

**所以續期的訊號必須來自 IdP session（使用者的登入是否還在），而不是 app 的行為。**

## 各 IdP 的撤銷能力差距（決定續期機制的品質）

| IdP | logout 通知 | 細節 |
|---|---|---|
| **Casdoor** | ✅ webhook | payload 含 `sessionIds`、`accessTokenHashes` 與 HMAC-SHA256 簽章；內部 `ExpireTokensBySessionIds` 會讓 introspection／refresh 一併拒絕 |
| **Keycloak** | ⚠️ 需社群 extension | 只有 Admin REST 可輪詢；webhook 需 `keycloak-events` 等 extension，非內建 |
| **Logto** | ❌ 無此事件 | webhook 清單完全沒有 logout／session revoked 事件，只能輪詢 sessions API；且 `offline_access` 的 end-session **不撤銷 grant**，refresh token 可用到 grant 到期（預設 TTL 180 天） |

**結論：PHI 撤銷語意下 Casdoor > Keycloak > Logto。** Logto 的 webhook 缺口是結構性的，這應寫進 IdP 選型文件。

**Revocation latency 是合約的一部分。** 臨床實務上醫師可能需要 4 小時，因此 TTL 放寬到 4 小時是合理的——但那 4 小時同時是「撤銷最壞要等多久」的上限。在 Logto 上這個上限是事實而非合約，因為連即時撤銷都做不到。**這是明確要告知醫院的取捨。**

## Consequences

- **launch context 的 TTL 不是一個純技術參數，它是對外承諾。** 改動它等於改動合約。
- 續期機制需要一個「查 IdP session 存活性」的 adapter。其品質取決於 IdP：Casdoor 可用 webhook（近乎即時），Keycloak 只能輪詢，Logto 輪詢且有 180 天 grant 的繞過路徑。
- **SMART 的 `management_endpoint` 功能放棄**（context 不在 token 裡，introspection 回應也不帶 context）。SMART 2.2 中該端點是 RECOMMENDED 而非 SHALL，但這確實影響第三方 App 的「管理已授權 App」頁面，是取捨而非免費。
- 排入失效路徑的行為必須是 **fail-closed**：查不到 context 就拒絕。需要 context 的路徑（patient／list 模式）在 store 故障時絕不可退化為「視為無 patient 限制」——那會讓填滿 Valkey 或維護窗口變成一個靜態的越權開關。不需要 context 的路徑可繼續服務。