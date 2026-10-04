# 測試說明

## 唯一的測試 seam：整個 app over HTTP

新增測試時**預設走這條路**，不要為每個介面各開一個單元測試 seam。

好的測試：給定一個 token 與一個 HTTP 請求，斷言 gateway app 回傳的 status code 與 FHIR response。
壞的測試：斷言某個 resolver 有被呼叫、某個 DTO 有某個欄位、某個常數的字串值，或在只有 status code 有意義時去斷言錯誤訊息逐字相符。

**Prior art 與範本**：`tests/bearer-authorization.test.ts` — 它組出真實的 app（`createApp`），
搭配 stub IdP 與 stub FHIR upstream，用 `app.handle(new Request(...))` 驅動，斷言真實回應。

為什麼只有一個 seam：本 spec 引入的三個介面（signing key resolver、launch context、scope resolver）
控制的所有行為，最後都會體現成一個 response status code。為每個介面另開單元 seam 只會把測試釘在
下一波重構就會失效的內部形狀上。

## 兩種測試風格

| 風格 | 用途 | 範本 |
| --- | --- | --- |
| app over HTTP | 預設。授權裁決、信任路徑、錯誤碼 | `tests/bearer-authorization.test.ts` |
| 單元（窄） | 只在該行為無法經 HTTP 觀察時才用 | `tests/smart-scope.test.ts`、`tests/audit-event.test.ts` |

後者仍需斷言**可觀察行為**，不可斷言內部形狀。

## Helpers

寫測試前先看這裡，多半不需要自己造 stub。

### `helpers/issuer-test-server.ts` — stub IdP

`startIssuerTestServer()` 開一個真實的 HTTP 伺服器作為 IdP，回傳 `{ issuerUrl, keys, requests, ... }`。

- 提供 RSA key pair（`keys.privateKey` 供 `SignJWT` 簽 token），並可匯出 Keycloak 格式的
  `keys.publicKeyBase64`（base64 SPKI DER）。
- `keys` 之外可呼叫 `rotateSigningKey()` 模擬 IdP 換金鑰，用來驗證簽章輪替不需要重啟 gateway。
- `setJwksAvailability("unreachable")` 讓 JWKS 端點在連線層失敗，用來驗證 refresh 失敗時的行為。
- `requests` 記錄 `root` / `jwks` / `wellKnown` 的請求次數，用來斷言「只走某一條 trust path」
  與「啟動時只 fetch discovery 一次」。
- 選項可控制服務模式：`serveJwks`（是否供應 JWKS）、`publishJwksUri`（discovery 是否宣告
  `jwks_uri`）、`jwksKeyCount`（發布幾把金鑰）。三者可組出 jwks-only、keycloak-only、兩者皆有。
- `close()` 記得在 `afterEach` 呼叫。

搭配 `signTestJwt(issuer, privateKey)` 產生最小 token。

### `helpers/launch-context-fixture.ts` — launch context

`launchContextFromClaims(claims)` 用**真實的** `DefaultLaunchContextProvider` 把 JWT claim 轉成
`LaunchContext`。測試不需要知道 claim name 的細節——這是刻意的：改用真實 provider 才能確保
測試不會因為 claim name 改動而與實際行為脫節。

單元測試 access checker 時用它取代過去直接塞 `jwt` 的寫法。

### `helpers/access-checker-fixture.ts` — access checker 測試常數

`PATIENT_AUTHORIZED` / `PATIENT_NON_AUTHORIZED` / `TEST_LIST_ID` /
`PATIENT_IN_BUNDLE_1` 等固定 id。刻意用一致的常數而非散落的字串量，讓「同一個病人」在多個
測試之間可辨識。

### `helpers/mock-http-fhir-client.ts` — mock FHIR client

`MockHttpFhirClient` 實作 `HttpFhirClientLike`，供**同步**的 checker 單元測試使用。

- `registerGet(path, bundle)` 註冊某個 FHIR 讀取路徑要回什麼 bundle。
- `getResource(path)` 未註冊時拋錯——這是刻意設計，讓「沒註冊」不會被誤當成空結果。
- `patchCalls` 記錄所有 PATCH，用來斷言寫入行為（例如新建立的 Patient 有被加回 List）。

需要走真實 app 與真實 HTTP 時，用 `tests/bearer-authorization.test.ts` 內建的 upstream stub，
不要用這個 mock。

### `helpers/eden.ts` — HTTP client

`createTestClient()` 建立 Elysia 的 Eden treaty client，供直接對 app 發請求使用
（`app.handle()` 之外的選擇）。

### `helpers/fhir-request.ts` — 請求建構

`buildFhirRequest(requestPath, queryParams?, requestType?, requestBody?)` 產生
`FhirRequestDetails`，供直接呼叫 `checker.checkAccess(...)` 的單元測試使用。

### `helpers/allowed-queries-fixture.ts` / `helpers/patient-finder-fixture.ts` — fixture 檔

`allowedQueriesFixturePath(file)` / `patientFinderFixturePath(file)` 回傳 `tests/fixtures/`
底下檔案的路徑；後者另附 `readPatientFinderBundle(file)` 直接讀成 `FhirBundle`。

## Fixtures

`tests/fixtures/` 依用途分目錄：

- `access-checker/` — 各 access checker 的 bundle 樣本
- `allowed-queries/` — allowed query 設定檔樣本
- `patient-finder/` — patient finder 的 bundle 樣本
- `idp_keycloak_config.json` — stub IdP 的 discovery document。檔名標示它是**以 Keycloak 為範本**
  的範例，不是 gateway 的相依項。

## 執行

```bash
pnpm test              # 全部
pnpm vitest run tests/issuer-policy.test.ts   # 單一檔案
pnpm run typecheck     # tsc --noEmit
pnpm run lint          # biome check
pnpm run verify        # typecheck + lint + test
```

工具鏈注意事項見 repo 根目錄 `AGENTS.md`。特別注意：**不要用 `npx tsc` 或 `npx biome`**，
這兩個在本 repo 會解析到錯誤的執行檔。