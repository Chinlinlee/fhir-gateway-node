# Codebase map

這個 repo 的模組邊界與**隱藏耦合**。讀它取代「grep 整個 repo 摸路」——特別是那些從檔名
看不出來、但改錯就會壞的條件式。

詞彙一律用 `CONTEXT.md` 的定義。

## 目錄

```
src/
├── index.ts              # 唯一的 production 啟動點；組裝 config → store → tokenVerifier → createApp
├── app.ts                # createApp：所有相依的組裝與路由註冊都在這裡
├── configs/              # env.schema.ts（zod 形狀）+ index.ts（loadGatewayConfig：解析與啟動期驗證）
├── constants/            # ENV_KEYS、預設值、路由前綴、FHIR 資源型別表
├── controllers/          # 每個 controller 一支；把 route deps 收斂成一次呼叫
├── errors/               # 例外類別；**不帶 status**，見下方「錯誤 → status」
├── routes/               # Elysia route 模組；只做路由與錯誤轉譯
├── services/             # 領域邏輯的主體
├── types/                # 介面與 DTO（LaunchContext、LaunchContextStore、AccessDecision…）
├── utils/                # 無狀態工具
├── validations/          # 外部輸入的 zod schema（OIDC discovery、FHIR 路徑…）
└── resources/            # 靜態資料（CompartmentDefinition、allowed queries 範例）
```

## app.ts 裡的條件式——最容易被改壞的地方

路由註冊**全部是條件式**，而且條件各不相同：

| 路由 | 註冊條件 |
| --- | --- |
| `healthRoute` | 永遠註冊（`createApp()` 無參數時只有它） |
| `internalLaunchRoute` | `internalLaunchApiEnabled === true` **且** 有內部憑證。**不依賴 tokenVerifier** |
| `smartRoute` | 有 `tokenVerifier` **且** public base URL **且** gateway 的 IdP client 憑證三項齊全 |
| `wellKnownRoute` | 有 `tokenVerifier`；只有在代理授權流程時才改寫 endpoint |
| `fhirRoute` | 有 `tokenVerifier` **且** 有 `config` |

三個隱藏耦合，改之前先讀懂：

- **內部註冊端點與代理的授權流程共用同一個 `launchContextStore` instance。** `authorize` 檢查的
  launch id 必須就是 EHR 剛建立的那一份，綁定也必須寫進同一份。傳兩個 store 進 `createApp`
  會讓流程在測試裡通過、在正式環境失效。
- **`FhirBackendService` 的建立條件同時看兩件事**：`auditEventService === undefined` **或**
  `accessChecker === "list"`。也就是說稽核與 list checker 共用這個 backend，改動會同時影響兩者。
- **稽核的唯一開關是 `AUDIT_EVENT_ACTIONS_CONFIG`**（`config.auditEventActions.length > 0`），
  空值代表完全不稽核。

## 設定的加法

新增一個環境變數要動四處，缺一處就會靜默失效：

1. `src/constants/config.ts` 的 `ENV_KEYS`
2. `src/configs/env.schema.ts` 的 schema 欄位
3. `src/configs/index.ts` 的解析（需要轉型或有啟動期驗證時，在這裡拋 `ConfigError` 並指名該 key）
4. `env.example` 與 `README.md` 的環境變數清單

可抄的既有範例：`TOKEN_AUDIENCE`（逗號分隔清單，空值等同未設定）、`SIGNING_KEY_SOURCE`
（列舉 + 啟動期驗證）。

## 錯誤 → status

例外類別**不帶 status code**，轉譯發生在使用它的地方：`FhirProxyController` 的 catch，
以及 `smart.route.ts` 的 OAuth 錯誤分支。`BackendCredentialError` 特別要求 `cause` 不外洩。

| 例外 | status | 觸發點 |
| --- | --- | --- |
| `AuthenticationError` | 401 | launch context 欄位缺失、scope 不足、Factory 初始化失敗 |
| `InvalidRequestError` | 400 | body / path 無法解析 |
| `accessDenied()`（非例外） | 403 | 授權邏輯判定拒絕 |
| `BackendCredentialError` | 503 | gateway 自己的 backend 憑證（ADC）無法取得 |
| `OAuthError` | 400 / 5xx | SMART 授權流程；`oauth.error` 與 `oauth_error` 兩種形狀 |

啟動期另有 `ConfigError`（設定本身不合法）與 `StartupConnectionError`（連不到外部服務，
訊息指名環境變數並附上原始 cause）。

## 授權資料流

```text
GET /fhir/*
  → FhirProxyController.handle
  → tokenVerifier 驗簽（trust path：jwks / keycloak-public_key）
  → launchContextProvider.create(verifiedJwt)
      scopes + agent  ← verified token
      patientId / patientListId ← launchContextStore.getByAccessToken(token 的 jti)
  → accessCheckerFactory.create({ launch, patientFinder, fhirBackend? }).checkAccess(request)
  → allowedQueries 檢查
  → httpFhirClient 轉發；patient 模式下未帶搜尋參數時注入 patient
  → auditEventService.log(request, …)
```

授權層不讀 raw JWT claims——claim 名稱只存在於 `LAUNCH_CLAIM_NAMES`。

## 兩個容易誤判的設定

- **`biome.json` 的 `vcs.useIgnoreFile` 是 `false`**，所以 biome **不讀 `.gitignore`**。
  任何要被 lint 排除的目錄都要另外列進 `files.includes`（例如 `!.scratch`）。
- **`OidcDiscoverySchema` 用 `.loose()`**：未知 key 不會被 strip，所以代理時新增欄位不必改
  schema。但它的欄位**全部必填**且 controller 用 `parse()`，IdP 少一個欄位就是 500，不是 400。

## 相關文件

- `CONTEXT.md` — 詞彙表
- `docs/adr/` — 決策
- `tests/README.md` — 測試 seam 與全部 helper
- `docs/agents/domain.md` / `docs/agents/issue-tracker.md`
