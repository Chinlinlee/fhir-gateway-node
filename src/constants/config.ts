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
} as const;

export const DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH = false;

export const DEFAULT_WELL_KNOWN_ENDPOINT = ".well-known/openid-configuration";
export const DEFAULT_RUN_MODE = "PROD";
export const DEFAULT_PORT = 3000;

export const DEFAULT_INTERNAL_LAUNCH_API_ENABLED = false;
export const DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS = 600;

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
