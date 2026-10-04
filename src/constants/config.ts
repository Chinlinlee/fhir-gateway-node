export const ENV_KEYS = {
    PROXY_TO: "PROXY_TO",
    TOKEN_ISSUER: "TOKEN_ISSUER",
    BACKEND_TYPE: "BACKEND_TYPE",
    ACCESS_CHECKER: "ACCESS_CHECKER",
    ALLOWED_QUERIES_FILE: "ALLOWED_QUERIES_FILE",
    AUDIT_EVENT_ACTIONS_CONFIG: "AUDIT_EVENT_ACTIONS_CONFIG",
    WELL_KNOWN_ENDPOINT: "WELL_KNOWN_ENDPOINT",
    RUN_MODE: "RUN_MODE",
    PORT: "PORT",
    /** When true, JWT iss may differ from TOKEN_ISSUER host if realm path matches. */
    ALLOW_TOKEN_ISSUER_HOST_MISMATCH: "ALLOW_TOKEN_ISSUER_HOST_MISMATCH",
    /** 驗簽金鑰來源：jwks | keycloak-public-key | auto */
    SIGNING_KEY_SOURCE: "SIGNING_KEY_SOURCE",
    /**
     * 本資源伺服器接受的 access token `aud` 值（逗號分隔）。留空則不做 `aud` 校驗。
     * Audience values this resource server answers to; empty disables the check.
     */
    TOKEN_AUDIENCE: "TOKEN_AUDIENCE",
    /**
     * 是否啟用 EHR 面向的內部 launch context 註冊端點。
     * Whether the EHR-facing internal launch context API is enabled.
     */
    INTERNAL_LAUNCH_API_ENABLED: "INTERNAL_LAUNCH_API_ENABLED",
    /**
     * 內部 launch context 端點的認證憑證；與 patient-facing bearer token 完全分開。
     * Credential guarding the internal launch context API; unrelated to bearer tokens.
     */
    INTERNAL_LAUNCH_API_CREDENTIAL: "INTERNAL_LAUNCH_API_CREDENTIAL",
    /**
     * 未綁定 launch context 的存活秒數；綁定前的 launch id 在這段時間內可被使用。
     * Lifetime of an unbound launch context, in seconds.
     */
    LAUNCH_CONTEXT_TTL_SECONDS: "LAUNCH_CONTEXT_TTL_SECONDS",
    /**
     * **已綁定** launch context 的存活秒數。綁定後的 context 也會到期：到期之後 patient／list
     * 模式的請求以 401 拒絕，而不是繼續拿著一位病人的參照。
     * Lifetime of a bound launch context, in seconds (ADR-0004).
     */
    LAUNCH_CONTEXT_BOUND_TTL_SECONDS: "LAUNCH_CONTEXT_BOUND_TTL_SECONDS",
    /**
     * gateway 對外可被 App 呼叫的 base URL；`authorize` 轉發與 SMART configuration 的端點
     * 改寫都以它為準，絕不從請求的 `Host` header 推導。設定它等同啟用代理的授權流程。
     * Authoritative public base URL used for endpoint rewriting; never derived from `Host`.
     */
    GATEWAY_PUBLIC_BASE_URL: "GATEWAY_PUBLIC_BASE_URL",
    /**
     * gateway 自己拿來當 IdP client 的 client id。gateway 不簽任何 token，這組憑證只用來
     * 在 callback 時向 IdP 的 token endpoint 換 token（ADR-0001：簽發權留在 IdP）。
     */
    GATEWAY_CLIENT_ID: "GATEWAY_CLIENT_ID",
    /** 對應的 client secret；啟用授權流程而未設定時啟動即失敗。 */
    GATEWAY_CLIENT_SECRET: "GATEWAY_CLIENT_SECRET",

    /**
     * launch context store 的實作選擇：memory（測試／單機開發）或 valkey（正式環境）。
     * Which launch context store implementation backs the gateway.
     */
    LAUNCH_CONTEXT_STORE: "LAUNCH_CONTEXT_STORE",
    /**
     * Valkey 連線 URL。TLS 與認證都寫在這支 URL 裡（`rediss://user:password@host:6379`）——
     * store 內存著病人與就診參照（PHI）與 access token 的綁定索引，因此正式環境必須走加密
     * 且有認證的連線。IdP 的 token 本體不在這裡，它留在 process 的 authorization session。
     * Valkey connection URL; TLS and credentials are carried by the URL itself.
     */
    LAUNCH_CONTEXT_VALKEY_URL: "LAUNCH_CONTEXT_VALKEY_URL",
} as const;

export const DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH = false;

export const DEFAULT_WELL_KNOWN_ENDPOINT = ".well-known/openid-configuration";
export const DEFAULT_RUN_MODE = "PROD";
export const DEFAULT_PORT = 3000;

export const DEFAULT_INTERNAL_LAUNCH_API_ENABLED = false;
export const DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS = 600;

/**
 * 已綁定 launch context 的預設 TTL：4 小時（14400 秒）。
 *
 * 數字來自 ADR-0004 的理由，而不是「四捨五入好記」：臨床實務上醫師處理同一位病人可能需要
 * 4 小時，ADR-0004 也因此把 4 小時定為對外承諾的上限。**這同時是撤銷最壞要等多久的上限**——
 * 這個 store 目前沒有 session 存活檢查可以續期（那是 ADR-0004 的另一半，不在本專案），
 * 因此到期就是真的到期。
 */
export const DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS = 14400;

/**
 * Launch context store 的可選實作。`memory` 是測試與單機開發的預設值，**不適合正式環境**：
 * 多 instance 之間看不到彼此的綁定，gateway 一重啟所有進行中的 launch 就全部失效。
 */
export const LAUNCH_CONTEXT_STORE_TYPES = ["memory", "valkey"] as const;
export type LaunchContextStoreType = (typeof LAUNCH_CONTEXT_STORE_TYPES)[number];

export const DEFAULT_LAUNCH_CONTEXT_STORE: LaunchContextStoreType = "memory";

export const SIGNING_KEY_SOURCES = ["jwks", "keycloak-public-key", "auto"] as const;
export type SigningKeySource = (typeof SIGNING_KEY_SOURCES)[number];

export const DEFAULT_SIGNING_KEY_SOURCE: SigningKeySource = "auto";

export const BACKEND_TYPES = ["HAPI", "GCP"] as const;
export type BackendType = (typeof BACKEND_TYPES)[number];

export const RUN_MODES = ["DEV", "PROD"] as const;
export type RunMode = (typeof RUN_MODES)[number];

// 內建插件名稱
export const BUILTIN_ACCESS_CHECKERS = ["list", "patient", "basic"] as const;

/**
 * 與 Java FhirProxyServer.AUDIT_EVENT_ACTION_CODES 一致。
 */
export const AUDIT_EVENT_ACTION_CODES = ["C", "R", "U", "D", "E"] as const;
export type AuditEventActionCode = (typeof AUDIT_EVENT_ACTION_CODES)[number];
