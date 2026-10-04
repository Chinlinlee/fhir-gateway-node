# SMART FHIR Gateway

醫療院內部的 FHIR 存取授權閘門。聰明醫療 App（SMART on FHIR App）以 OAuth 2.0 bearer token 存取 FHIR 資源；gateway 驗證 token、依 SMART scope 與病人 context 裁決可存取的資源、稽核每一次存取，並把請求轉發給後端 FHIR 伺服器（HAPI 等）。

## 授權語言

**Launch context**:
一份描述這次授權「正在處理哪個病人／哪次就診／哪份病人清單」的上下文，**由 gateway 自己持有**（ADR-0002）：EHR 在 App 開啟前向 gateway 註冊它，gateway 記住內容並管理生命週期，access token 不再攜帶病人資訊——token 被竊取時不直接洩漏 PHI。它是 patient compartment 與 patient list 裁決的依據，不是 token 內的欄位。
_Avoid_: launch context claim、context claim（指稱 token 內欄位，會誤導）

**Launch id**:
EHR 建立一份 launch context 時取得的單次 opaque 識別碼，交給 SMART App 當 `authorize` 請求的 `launch` 參數。使用者在授權伺服器完成認證的瞬間，它與使用者身分同時在手——這個瞬間就是綁定點。
_Avoid_: launch token、context id（易與後者混淆）

**綁定點（binding point）**:
launch id 與已認證使用者被寫成一筆 `(subject, client id) → launch context` 記錄的那一刻。它發生在 gateway 代理的 authorization flow 的 **callback**——使用者完成認證之後、App 拿到 token 之前——而非授權完成後。
_Avoid_: context resolution（指稱後續查詢，混淆建立與讀取）

**Launch context 索引鍵**:
授權裁決時，gateway 認出「這次請求屬於哪一次授權」所使用的鍵。**不是** `(subject, client id)`：gateway 是 token endpoint 上的 OAuth client，access token 的 `azp` 是 gateway 自己，token 裡沒有任何欄位指出是哪個 App。實際的鍵是**這張 access token 自己的 `jti`**，由 gateway 在把 token 交給 App 的那一刻接到綁定上；refresh 換發新 token 時同樣接上，因此 refresh 後仍然解析得到。這讓同一位醫師同時開兩個 App、兩個不同病人時，各自解析到自己的病人。

**Revocation latency**:
使用者登出後，最後一次被允許的 PHI 存取距發生的時間上限。取決於 IdP 的登出通知能力，不是 TTL 本身。
_Avoid_: session timeout、token 過期時間

## 身分與信任

**Identity provider（IdP）**:
證明使用者是誰並簽發 access token 的元件。**本專案不要求它是 Keycloak，也不要求它理解 SMART 語意。**
_Avoid_: authorization server（SMART 規格中 AS 是院方認證授權伺服器，此處指外部簽發者時會混淆）

**Trust path**:
gateway 取得簽章金鑰並驗證 token 的途徑。標準途徑是 OIDC discovery 的 `jwks_uri`；舊途徑是 Keycloak 專屬的 `public_key`，僅為相容既有環境保留。
_Avoid_: key source、verification mode

**Tenant boundary**:
一家醫院與另一家醫院之間的隔離。以 **per-realm issuer** 為主（不同 realm 發出的 token 簽章即不相容），以 **`aud` 校驗**為縱深防禦——後者需設定 `TOKEN_AUDIENCE` 才生效（見 ADR-0003）。
_Avoid_: multi-tenancy、hospital isolation（皆指稱部署而非邊界機制）

**Audience（`aud`）**:
token intended 給哪個資源伺服器。RFC 9068 §4 要求資源伺服器拒絕 `aud` 不含自己的 token——這是 MUST，不是建議。
_Avoid_: target、resource indicator

## 稽核

**Access AuditEvent**:
每一次 FHIR 存取的稽核紀錄。**Launch AuditEvent**則記錄 launch context 的建立、綁定與撤銷；建立與綁定已實作，撤銷依附於 ADR-0004 的 session 存活檢查。兩者是不同的稽核類別，共用同一管道，並以 `AuditEvent.type.system` 分流。
_Avoid_: audit log、access log（後者是 HTTP 層紀錄，不含授權決策）