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
} as const;

export const DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH = false;

export const DEFAULT_WELL_KNOWN_ENDPOINT = ".well-known/openid-configuration";
export const DEFAULT_RUN_MODE = "PROD";
export const DEFAULT_PORT = 3000;

export const BACKEND_TYPES = ["HAPI", "GCP"] as const;
export type BackendType = (typeof BACKEND_TYPES)[number];

export const RUN_MODES = ["DEV", "PROD"] as const;
export type RunMode = (typeof RUN_MODES)[number];

// 內建插件名稱
export const BUILTIN_ACCESS_CHECKERS = ["list", "patient"] as const;

/**
 * 與 Java FhirProxyServer.AUDIT_EVENT_ACTION_CODES 一致。
 */
export const AUDIT_EVENT_ACTION_CODES = ["C", "R", "U", "D", "E"] as const;
export type AuditEventActionCode = (typeof AUDIT_EVENT_ACTION_CODES)[number];
