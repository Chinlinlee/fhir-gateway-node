# FHIR Gateway Node — 產品需求文件 (PRD)

> 來源規格：[`fhir-gateway.SPEC.md`](../fhir-gateway.SPEC.md)（逆向自 `fhir-gateway` v0.5.0）  
> 目標：以 **Elysia** 重實作 FHIR Information Gateway，行為與 Java 版對齊（另有明確差異見下文）。  
> 測試：每項功能完成後必須有對應測試；參照 Java `server/src/test`、`plugins/src/test` 案例，**能不 mock 就不 mock**。  
> 測試框架：**Eden Treaty**（`@elysiajs/eden`）。

---

## 技術約束（全專案）

| 項目 | 要求 |
|------|------|
| HTTP 框架 | [Elysia](https://elysiajs.com/) + [@elysia/node](https://elysiajs.com/integrations/node.html) |
| 架構 | 遵守 [Elysia Best Practice](https://elysiajs.com/essential/best-practice.html)：Route 薄、Controller 無 HTTP、Service 承載業務、Schema 在 validations |
| 對外 HTTP | **undici**（禁止 axios） |
| 後端 FHIR 客戶端 | [fhir-kit-client](https://npmx.dev/package/fhir-kit-client)（Node 無 HAPI client 的替代） |
| FHIR 版本 | R4（硬編碼，與原版一致） |
| Servlet 路徑 | 原版 `/fhir/*`；Node 版建議 prefix `/fhir`（可調，需在 config 固定） |
| `PatientAccessChecker` JWT claim | **`PATIENT_CLAIM = "patient"`**（原版 Java 為 `patient_id`；本專案刻意採用 `patient`） |
| `PatientAccessChecker` scope principal | 僅使用 `Principal.PATIENT`（`patient/...` scopes） |
| 目錄結構 | `configs` / `constants` / `controllers` / `middlewares` / `routes` / `services` / `types` / `utils` / `validations` / `models` |
| **驗證（Schema）** | **統一使用 [Zod](https://zod.dev/)**（Elysia [Standard Schema](https://elysiajs.com/essential/validation)）；**禁止**新增 `Elysia.t` / TypeBox schema |

### 驗證規範（Zod）

- **HTTP route**（`body` / `query` / `params` / `response`）：在 `validations/**/*.schema.ts` 定義 `z.object(...)`，掛到 route 第三參數；型別用 `z.infer<typeof Schema>`。
- **非 HTTP**（環境變數、設定檔、純業務 DTO）：同樣用 Zod；可放 `configs/*.schema.ts` 或 `validations/**/*.schema.ts`。
- **不要**使用 `import { t } from 'elysia'` 撰寫新 schema；`@sinclair/typebox` 若為 Elysia 傳遞依賴可保留，不主動新增 TypeBox 程式碼。
- 錯誤處理：`schema.safeParse()` 或 `.parse()`；對外拋出專案自訂錯誤（如 `ConfigError`）。

### 建議目錄對照（Elysia best-practice → 本 repo）

| Best-practice 概念 | 本專案路徑 |
|--------------------|------------|
| `model` (schema) | `validations/**/*.schema.ts` 或 `configs/*.schema.ts`（**Zod**；命名如 `GatewayConfigSchema`，避免與 DB model 混淆） |
| `service` | `services/**/*.service.ts` |
| route handler 本體 | `controllers/**/*.controller.ts`（純函數，不接 `Request`） |
| Elysia plugin | `middlewares/**/*.ts` |
| 路由組裝 | `routes/**/*.ts` |
| 啟動與 export app | `src/app.ts`（供 Eden Treaty 與 `src/index.ts` 共用） |

---

## 實作狀態圖例

- `- [ ]` 未完成
- `- [x]` 已完成（實作 + 測試通過）

---

## Phase 0 — 專案基礎建設

### 0.1 依賴與腳本

- [x] 安裝並鎖定：`undici`、`fhir-kit-client`、`jose`（或等效 RS256 JWT）、`@elysiajs/eden`、`vitest`、`zod`（需能跑 Eden Treaty）
- [x] `package.json` scripts：`dev`、`build`、`start`、`test`、`test:watch`
- [x] TypeScript strict（`noImplicitAny` 等），**禁止 `any`**（必要時用 `unknown` + narrow）

### 0.2 應用骨架（可測試的 app factory）

- [x] `src/app.ts`：建立 `Elysia` 實例並 export `App` type（Eden Treaty 需要）
- [x] `src/index.ts`：僅負責 listen + 讀取 config port（`PORT`，預設 3000）
- [x] Eden Treaty 測試 helper：`tests/helpers/eden.ts`（`treaty(app)` + lifecycle）
- [x] 測試：`tests/app.test.ts` — 能透過 Treaty 打到健康檢查或根路徑（無 mock）

### 0.3 設定載入（對應 SPEC §4）

- [x] `configs/env.schema.ts` + `configs/index.ts`：啟動時驗證環境變數
- [x] 必要變數：`PROXY_TO`、`TOKEN_ISSUER`、`BACKEND_TYPE`（`HAPI` \| `GCP`）、`ACCESS_CHECKER`（`list` \| `patient` \| 自訂名）
- [x] 選用：`ALLOWED_QUERIES_FILE`、`AUDIT_EVENT_ACTIONS_CONFIG`、`WELL_KNOWN_ENDPOINT`（預設 `.well-known/openid-configuration`）、`RUN_MODE`（`DEV` \| `PROD`，預設 `PROD`）
- [x] `AUDIT_EVENT_ACTIONS_CONFIG` 非法字元 → 啟動失敗（對照 `IllegalStateException`）
- [x] `RUN_MODE=DEV`：`TOKEN_ISSUER` mismatch 容忍、`ACCESS_CHECKER=permissive` 僅 DEV 可用
- [x] 測試：`tests/config.test.ts` — 缺必要變數 / 非法 audit 字元 / DEV permissive 規則（無 mock）

### 0.4 靜態資源與常數

- [x] 從 `fhir-gateway/resources` 複製：`CompartmentDefinition-patient.json`、`patient_paths.json`、`hapi_page_url_allowed_queries.json` 等（置於 `src/resources/`）
- [x] `patient_params.json`：由 `CompartmentDefinition-patient.json` 產生（`scripts/generate-patient-params.mjs`），供 proxy 注入 compartment search param
- [x] `constants/fhir.ts`：R4、封鎖的 search 修飾（chaining、`_has`、`_include`、`_revinclude`）
- [x] 測試：資源檔可被載入且 JSON 合法（無 mock）

### 0.5 CORS middleware

- [x] `middlewares/cors.ts`：`@elysiajs/cors`，允許 `Authorization` header（SPEC §12）
- [x] 測試：`app.handle` OPTIONS preflight（無 mock）

---

## Phase 1 — JWT 與 Token 基礎設施（SPEC §5）

> Java 參考：`TokenVerifierTest.java`

### 1.1 TokenVerifier Service

- [x] `services/token-verifier.service.ts`：解析 `Authorization: Bearer <JWT>`
- [x] 僅接受 **RS256**；向 `TOKEN_ISSUER` GET 取 `public_key`（Keycloak 格式 JSON）
- [x] 驗證 `iss` === `TOKEN_ISSUER`（`RUN_MODE=DEV` 可跳過 mismatch）
- [x] 無 token / 格式錯誤 / 驗簽失敗 → 401 類錯誤（對齊 `AuthenticationException` 語意）
- [x] 測試：`tests/token-verifier.test.ts`
  - [x] 有效 JWT 通過（RSA key pair + 本地 issuer HTTP server，無 mock service）
  - [x] 錯誤 issuer / 錯誤簽章 / 缺少 Bearer 拒絕
  - [x] DEV 模式 issuer mismatch 仍通過

### 1.2 SMART well-known 端點（免 JWT）

- [x] `routes/well-known.route.ts`：`GET /fhir/.well-known/smart-configuration`
- [x] 從 `TOKEN_ISSUER` + `WELL_KNOWN_ENDPOINT` 代理 OIDC JSON（啟動時由 `TokenVerifierService` 快取）
- [x] 測試：`tests/well-known.test.ts` — 對照 `BearerAuthorizationInterceptorTest.authorizeRequestWellKnown`

---

## Phase 2 — Allowed Queries 白名單（SPEC §6）

> Java 參考：`AllowedQueriesCheckerTest.java`

### 2.1 AllowedQueriesChecker Service

- [x] `services/allowed-queries.service.ts`：載入 JSON `entries[]`
- [x] `checkUnAuthenticatedAccess()` 優先於需 JWT 的流程
- [x] `checkAccess()`：JWT 驗證後 bypass AccessChecker
- [x] 欄位語意：`path`（含 `/ANY_VALUE` prefix）、`requestType`、`queryParams`（`ANY_VALUE`）、`allowExtraParams`、`allParamsRequired`、`allowUnauthenticatedRequests`
- [x] 未設定 `ALLOWED_QUERIES_FILE` → checker 停用
- [x] 測試：`tests/allowed-queries.test.ts`（對照 Java 測試案例名稱）
  - [x] `validGetPagesQuery` — `?_getpages=A_PAGE_ID`
  - [x] `validGetPagesQueryExtraValue` — multi-value `_getpages`
  - [x] `validGetPagesQueryExtraParam` — 額外 query param + `allowExtraParams`
  - [x] `validUnAuthenticatedQuery`
  - [x] `validExactPathMatch` / `validPathWithVariableAnyParamValueMatch`
  - [x] 拒絕案例（錯誤 path、缺 param、`allowExtraParams: false` 等，對照 Java 負向測試）

---

## Phase 3 — PatientFinder（SPEC §7）

> Java 參考：`FhirUtilTest.java`、`PatientFinderImp`（間接）、AccessChecker 測試中的 patient 推斷

### 3.1 PatientFinder Service

- [x] `services/patient-finder.service.ts`
- [x] `findPatientsFromParams(path, queryParams)`：
  - [x] `GET /Patient/{id}` → 單一 id
  - [x] `GET /Patient?_id=...` → 逗號分隔多 id
  - [x] compartment search param 對應（`CompartmentDefinition-patient.json`），例如 `GET /Encounter?patient=123`、`GET /Observation?patient=123`
  - [x] 非 Patient read/search：有 compartment param 則解析；**無 param 時回傳空集合**（不拒絕 `GET /Encounter/{id}` 等標準 client URL）
  - [ ] **Proxy（Phase 7）**：無 patient query 時，依 JWT `patient` + `patient_params.json` 注入，例如 `GET /Encounter/enc-123` → `GET /Encounter/enc-123?patient=Patient/456`
- [x] 硬編碼 `blockJoins=true`：拒絕 chaining、`_has`、`_include`、`_revinclude`
- [x] `findPatientsInBundle(bundle)`：僅 `type=transaction`；支援 GET/POST/PUT/PATCH/DELETE entries；PATCH 僅 `Binary` + `application/json-patch+json`
- [x] 輸出結構：`referencedPatients`、`updatedPatients`、`deletedPatients`、`patientsToCreate`（對齊 `BundlePatients`）
- [x] 測試：`tests/patient-finder.test.ts` — 使用 `fhir-gateway` / plugins test resources JSON，**不 mock FHIR 解析**

---

## Phase 4 — AccessChecker 框架（SPEC §8）

### 4.1 型別與介面

- [x] `types/access-checker.ts`：`AccessChecker`、`AccessCheckerFactory`、`AccessCheckerCreateContext`
- [x] `types/access-decision.ts`：`AccessDecision`、`noOpAccessDecision`、`defaultUserWhoFromJwt`
- [x] `types/request-mutation.ts`：`RequestMutation`（`additionalQueryParams`、`discardQueryParams`）
- [x] `utils/request-mutation.util.ts`：`applyRequestMutation`（對齊 `BearerAuthorizationInterceptor.mutateRequest`）
- [x] Factory registry：`services/access-checker-registry.service.ts` 依名稱註冊／建立（`permissive` / `list` / `patient`）

### 4.2 測試

- [x] `tests/access-decision.test.ts` — mutation 合併/刪除 query（對照 `mutateRequest` / `mutateRequestRemoveQueryParams`）
- [x] `tests/access-checker-registry.test.ts`、`tests/default-user-who.test.ts`

---

## Phase 5 — SMART Scope（Patient 插件前置）

> Java 參考：`SmartScopeCheckerTest.java`

### 5.1 SmartFhirScope + SmartScopeChecker

- [x] `services/smart-scope.service.ts`：解析 scope 字串
- [x] 格式：`(user|patient|system)/{ResourceType|*}.{cruds|read|write|*}`
- [x] v1：`read` → READ+SEARCH；`write` → CREATE+UPDATE+DELETE
- [x] v2：`cruds` 逐字元；`*` 全權限
- [x] `SmartScopeChecker` 僅評估 **`patient/`** principal
- [x] 測試：`tests/smart-scope.test.ts`
  - [x] `hasPermissionCreateObservationPatientPrincipal`
  - [x] `hasPermissionCreateObservationPatientPrincipalNoValidScope`
  - [x] `hasPermissionReadObservationPatientPrincipalAllResources`
  - [x] （其餘 Java 測試案例補齊）

---

## Phase 6 — 內建 AccessChecker 插件（SPEC §9）

### 6.1 ListAccessChecker（`ACCESS_CHECKER=list`）

> Java 參考：`ListAccessCheckerTest.java`、`AccessGrantedAndUpdateListTest.java`  
> JWT claim：`patient_list`

- [x] `services/access-checkers/list-access-checker.service.ts`
- [x] GET：`GET /List/{patientListId}` 僅自己的 list；search 需 **全部** patient 在 list
- [x] POST：`POST /Patient` 允許 + postProcess 加入 list；其他 resource **任一** patient 在 list
- [x] PUT/PATCH/DELETE：對照 SPEC §9.1 表格
- [x] Bundle transaction：禁止危險組合；新建 Patient → 更新 list
- [x] List 驗證查詢：`GET /List?_id=...&_elements=id&item=Patient/...`，`bundle.total == 1`
- [x] 測試：`tests/list-access-checker.test.ts` — 逐項對照 Java `@Test` 方法名（使用 test resources bundle/json）

### 6.2 PatientAccessChecker（`ACCESS_CHECKER=patient`）

> Java 參考：`PatientAccessCheckerTest.java`  
> JWT claims：**`patient`**（非 `patient_id`）、`scope`

- [x] `services/access-checkers/patient-access-checker.service.ts`
- [x] 常數 `PATIENT_CLAIM = "patient"`
- [x] GET/POST/PUT/PATCH/DELETE/Bundle 規則：對照 SPEC §9.2（POST Patient 拒絕、DELETE Patient 拒絕等）
- [x] 測試：`tests/patient-access-checker.test.ts` — 對照 Java 測試案例（claim 改為 `patient`）

### 6.3 PermissiveAccessChecker（僅 DEV）

- [x] `RUN_MODE=DEV` + `ACCESS_CHECKER=permissive`：有效 JWT 即放行（AllowedQueries 仍可 bypass）
- [x] PROD 選 permissive → 啟動失敗或拒絕載入
- [x] 測試：`tests/permissive-access-checker.test.ts`

---

## Phase 7 — 後端 FHIR Client 與代理轉發（SPEC §3、§10）

### 7.1 HTTP 轉發層（undici）

- [x] `services/http-fhir-client.service.ts`：抽象 `handleRequest`
- [x] 轉發 URL：`{PROXY_TO}/{path}?{params}`
- [x] 轉發 headers：保留 `content-type`、`accept-encoding`、`prefer`、`if-match` 等（SPEC §10.3）
- [x] **不轉發** Client `Authorization`；HAPI 後端 auth 為空；GCP 改用 service account token
- [x] 測試：`tests/http-fhir-client.test.ts` — 對照 `HttpFhirClientTest` / `GenericFhirClientTest`（可用 undici MockAgent 記錄請求，**不 mock undici 本身**）

### 7.2 fhir-kit-client 整合

- [x] `services/fhir-backend.service.ts`：讀寫 List/Patient/AuditEvent 等插件所需操作
- [x] `BACKEND_TYPE=HAPI`：一般 REST
- [ ] `BACKEND_TYPE=GCP`：Google Application Default Credentials + `cloud-platform` scope（可選 Phase，若無 GCP 環境則 integration test skip）
- [x] 測試：最小 read/search 對 mock FHIR server（優先本地 undici mock server 回傳 Bundle）

### 7.3 代理主流程（核心）

> Java 參考：`BearerAuthorizationInterceptorTest.java`

- [x] `middlewares/bearer-authorization.middleware.ts` 或 `controllers/fhir-proxy.controller.ts` + `routes/fhir.route.ts`：`ALL /fhir/*`
- [ ] 流程：well-known → metadata（無 JWT）→ AllowedQueries unauth → JWT → AllowedQueries auth → AccessChecker → mutate → 轉發 → postProcess → Audit → URL replace → response
- [x] `metadata`：`CapabilityPostProcessor` 等效 — OAuth/CORS 安全描述
- [x] `canAccess() === false` → 403 FHIR `OperationOutcome`
- [x] Response headers 白名單（SPEC §3.5）；不重寫 `content-length`/`content-type` 的處理方式與原版一致
- [x] Response body：`PROXY_TO` → Gateway base URL 字串替換（串流或 buffer 實作）
- [x] `Accept-Encoding: gzip` 時回 gzip（對照 `shouldSendGzippedResponseWhenRequested*`）
- [x] 測試：`tests/bearer-authorization.test.ts`（Eden Treaty + 測試用 JWT + mock 後端）
  - [x] `authorizeRequestPatient` / `authorizeRequestList`
  - [x] `authorizeRequestMetadata`
  - [x] `authorizeAllowedUnauthenticatedRequest`
  - [x] `deniedRequest`
  - [x] `authorizeRequestTestReplaceUrl`
  - [x] `mutateRequest` / `mutateRequestRemoveQueryParams`
  - [x] gzip 案例

---

## Phase 8 — AuditEvent（SPEC §11）

> Java 參考：`AuditEventHelperTest.java`

- [x] `services/audit-event.service.ts`：`AUDIT_EVENT_ACTIONS_CONFIG` 非空且 `getUserWho()` 存在時產生 `AuditEvent`
- [x] HL7 R4 + BALP minimal patterns；agent 欄位來自 JWT `sub`、`azp`、`jti` 等
- [x] POST AuditEvent 至同一 FHIR Store；失敗僅 log，不影響 client response
- [x] 測試：`tests/audit-event.test.ts` — 對照 `AuditEventHelperTest` + `BearerAuthorizationInterceptorTest` audit 案例

---

## Phase 9 — 整合與部署

- [ ] `README.md`：環境變數、docker-compose 對接、`test-smart` realm + `patient` claim 說明
- [ ] 與根目錄 `docker-compose.yaml` / `fhir-gateway/docker` 對齊的 e2e 手動驗證步驟
- [ ] （可選）移植 `fhir-gateway/e2e-test` 關鍵情境為 Node 腳本

---

## 明確非目標（V1 不實作，與 SPEC 一致）

- [ ] ~~Query Rewrite~~
- [ ] ~~Response security label 全面過濾~~
- [ ] ~~Reverse chaining (`_has`)~~（維持封鎖）
- [ ] ~~Bundle `batch`~~
- [ ] ~~JWKS 標準 endpoint~~（維持 Keycloak `public_key`）
- [ ] ~~FHIR 版本可配置~~
- [ ] ~~ES256 等額外 JWT 演算法~~

---

## 測試策略摘要

| 層級 | 工具 | 原則 |
|------|------|------|
| HTTP API | Eden Treaty (`@elysiajs/eden`) | 匯出 `app` 型別；整合測試優先 |
| 純邏輯 | 同上用 Treaty 或 unit test runner | PatientFinder、AllowedQueries、SmartScope 用 fixture JSON |
| 對外 HTTP | undici | issuer 公鑰、後端 FHIR 用 MockAgent / 本地 test server |
| 避免 | 整包 mock AccessChecker / mock undici | 只 mock **遠端邊界**（網路回應） |

### Java 測試對照索引

| Node 測試檔（規劃） | Java 來源 |
|---------------------|-----------|
| `tests/token-verifier.test.ts` | `TokenVerifierTest` |
| `tests/allowed-queries.test.ts` | `AllowedQueriesCheckerTest` |
| `tests/patient-finder.test.ts` | `FhirUtilTest` + PatientFinder 行為 |
| `tests/smart-scope.test.ts` | `SmartScopeCheckerTest` |
| `tests/list-access-checker.test.ts` | `ListAccessCheckerTest` |
| `tests/patient-access-checker.test.ts` | `PatientAccessCheckerTest` |
| `tests/bearer-authorization.test.ts` | `BearerAuthorizationInterceptorTest` |
| `tests/audit-event.test.ts` | `AuditEventHelperTest` |
| `tests/http-fhir-client.test.ts` | `HttpFhirClientTest`, `GenericFhirClientTest`, `GcpFhirClientTest` |

---

## 進度追蹤

| Phase | 完成項 / 總項 |
|-------|----------------|
| 0 | 0.1–0.5 完成 |
| 1 | 完成 |
| 2 | 完成 |
| 3 | 完成（Proxy 注入於 Phase 7 串接） |
| 4 | 完成 |
| 5 | 完成 |
| 6 | 完成 |
| 7 | 7.1 完成、7.2 部分完成（GCP 待補）、7.3 完成 |
| 8 | 完成 |
| … | … |

*完成實作後請將對應 `- [ ]` 改為 `- [x]` 並更新上表。*
