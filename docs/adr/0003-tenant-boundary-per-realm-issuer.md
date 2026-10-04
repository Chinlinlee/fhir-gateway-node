# Tenant 邊界採 per-realm issuer，aud 校驗為縱深防禦

部署模型為「每家醫院一套 gateway，IdP 由廠商統一維運」。**決定以 per-realm issuer 作為醫院間的隔離機制，並把 `aud` 校驗升格為強制項。**

## 為什麼

**共用單一 IdP 會讓 gateway 之間互相接受對方的 token。** 若所有醫院的 gateway 都信任同一個 issuer 的簽章，那醫院 A 取得的 token 在醫院 B 的 gateway 上驗簽會通過（簽章有效、`iss` 相同、`exp` 未過、`scope` 字串相同），而兩者的 `PROXY_TO` 指向不同的 FHIR 資料庫。**這是跨院 PHI 外洩。**

這不是假設的風險。gateway 今天**根本沒有校驗 `aud`**——`buildVerifyOptions` 只設 `issuer` 與 `algorithms: ["RS256"]`。目前靠「每家醫院自建 IdP」的部署拓撲擋住；一旦 IdP 統一到雲端，缺口就會打開。

**這是 RFC 的 MUST，不是最佳實務建議：**

- **RFC 9068 §4**：「The resource server **MUST validate** that the `aud` claim contains a resource indicator value corresponding to an identifier the resource server expects for itself. The JWT access token **MUST be rejected** if `aud` does not contain a resource indicator of the current resource server」
- **RFC 8725 §3.9**（JWT BCP）：同一 issuer 發給多 relying party 時，relying party **MUST** validate aud，缺失或不屬於自己 **MUST reject**
- **RFC 9700 §2.3**（OAuth 2.0 Security BCP，2025-01）：每個 RS **is obliged to verify** per request，非為本 RS 而發者 **MUST refuse**
- **SMART App Launch 2.2**：「The resource server **SHALL validate** that the `aud` parameter … matches the resource server's own FHIR endpoint」

（註：RFC 6749 §7 只要求 RS「MUST validate the access token」，未逐字要求 aud；RFC 8725 是 JWT BCP，OAuth Security BCP 是 RFC 9700。）

## 為什麼是 issuer 層為主

`aud` 校驗是被 RFC 要求的，但它**依賴 IdP 配得對**。issuer 層不需要任何 IdP 設定：Keycloak 每個 realm 是獨立 issuer（`.../realms/hospital-a` vs `.../realms/hospital-b`），簽章驗證這一關就已經擋掉了。RFC 8725 §3.12 明列此為隔離手段（「Use different issuers for different kinds of JWTs」）。

**兩層都要做，但角色不同：issuer 是結構性主防線，aud 是 MUST 要求的縱深防禦。** 缺了 aud 過不了稽核；缺了 issuer 隔離則一換 IdP 就失去防線。

`resolveVerifyIssuer` 現在以「realm pathname 相同」判斷 issuer 等價——**這段程式碼的存在本身說明部署模型早就是一院一 realm**，不是新引入的假設。

## Consequences

- **spec #1 的 ticket #5（抽出 issuer-matching policy）從 refactor 升級為安全邊界。** 那條 realm-pathname 規則不是待移除的技術債，它是 tenant 隔離的第一道防線；它需要的是測試，不是刪除。
- **`aud` 校驗的交付方式是 opt-in（`TOKEN_AUDIENCE`）。** RFC 9068 §4 是 MUST，但同一時間要求「已接受 token 的授權結果不得改變」的升級約束（issue #10 constraint 1）排除了「預設開啟」：既有部署的 IdP 未配 audience mapper 時，預設開啟會讓全部請求 401。因此 gateway 在 `TOKEN_AUDIENCE` 有值時才校驗，未設定時於 PROD 啟動印出警告。**MUST 尚未在預設狀態生效**——這一點不可被當成已完成的隔離能力。
  - Keycloak 需 audience protocol mapper 才能讓這個設定有意義；在 mapper 到位前，`aud` 這層防線實際上不存在，tenant 邊界仍完全靠 issuer。
- `aud` 校驗需要 IdP 能產出 per-tenant 的 `aud`。Logto 與 Casdoor 原生支援 RFC 8707 `resource`；Keycloak 需用 audience protocol mapper（原生 RFC 8707 仍是 open issue #14355），同一 client 多 `aud` 要靠 optional client scope 切換。**這是 IdP 選型的硬條件。**
- SMART 規格本身沒有描述「一個 AS 同時服務多個 EHR」的拓樸（心智模型是 1 AS : 1 EHR）。共用 IdP 時的 per-tenant `aud` 與 per-tenant client 綁定要自己解。
- 第三方 SMART App 開發商仍須為每家醫院註冊一次 client——SMART 2.2 明文這是規格預設（"the app must be registered with that EHR's authorization service"）。這是 trade-off，不是缺陷。