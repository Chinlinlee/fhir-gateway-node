import type {
    AuditEventActionCode,
    BackendType,
    RunMode,
    SigningKeySource,
} from "../constants/config";

import {
    AUDIT_EVENT_ACTION_CODES,
    BUILTIN_ACCESS_CHECKERS,
    DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH,
    DEFAULT_PORT,
    DEFAULT_RUN_MODE,
    DEFAULT_SIGNING_KEY_SOURCE,
    DEFAULT_WELL_KNOWN_ENDPOINT,
    ENV_KEYS,
    SIGNING_KEY_SOURCES,
} from "../constants/config";

import type { GatewayConfig } from "./env.schema";
import { GatewayConfigSchema } from "./env.schema";

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);

        this.name = "ConfigError";
    }
}

type EnvSource = Record<string, string | undefined>;

function requireEnv(env: EnvSource, key: string): string {
    const value = env[key]?.trim();

    if (!value) {
        throw new ConfigError(`The environment variable ${key} is not set!`);
    }

    return value;
}

function parseAuditEventActions(raw: string | undefined): AuditEventActionCode[] {
    const normalized = raw?.trim().toUpperCase() ?? "";
    if (normalized.length === 0) {
        return [];
    }

    const codes = [...normalized] as string[];
    const allowed = new Set<string>(AUDIT_EVENT_ACTION_CODES);

    for (const code of codes) {
        if (!allowed.has(code)) {
            // 對齊 Java：非法 AuditEvent Action 應使啟動失敗
            throw new ConfigError("Invalid AuditEvent Action value configured for AuditEvent logging");
        }
    }

    return codes as AuditEventActionCode[];
}

function parseBackendType(raw: string): BackendType {
    const value = raw.trimEnd().toUpperCase();
    if (value === "HAPI" || value === "GCP") {
        return value;
    }

    throw new ConfigError(`The environment variable ${ENV_KEYS.BACKEND_TYPE} is not set to either GCP or HAPI!`);
}

function parseBooleanEnv(raw: string | undefined, envKey: string, defaultValue: boolean): boolean {
    if (raw === undefined || raw.trim().length === 0) {
        return defaultValue;
    }

    const normalized = raw.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
        return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
        return false;
    }

    throw new ConfigError(`The environment variable ${envKey} must be true/false (got: ${raw})`);
}

function parseRunMode(raw: string | undefined): RunMode {
    const value = (raw?.trim().toUpperCase() ?? DEFAULT_RUN_MODE) as RunMode;
    if (value === "DEV" || value === "PROD") {
        return value;
    }
    throw new ConfigError(`The environment variable ${ENV_KEYS.RUN_MODE} must be DEV or PROD (got: ${raw})`);
}

function parseSigningKeySource(raw: string | undefined): SigningKeySource {
    const value = (raw?.trim().toLowerCase() ?? DEFAULT_SIGNING_KEY_SOURCE) as SigningKeySource;
    if (SIGNING_KEY_SOURCES.includes(value)) {
        return value;
    }
    throw new ConfigError(
        `The environment variable ${ENV_KEYS.SIGNING_KEY_SOURCE} must be jwks, keycloak-public-key or auto (got: ${raw})`,
    );
}

function validateAccessChecker(accessChecker: string, runMode: RunMode): void {
    if (accessChecker === "permissive" && runMode !== "DEV") {
        // 僅開發模式允許
        throw new ConfigError(
            `Environment variable ${ENV_KEYS.ACCESS_CHECKER} is 'permissive' but ${ENV_KEYS.RUN_MODE} is not DEV`,
        );
    }

    // 其餘非空字串保留給自訂插件（Phase 4 註冊表再嚴格檢查）
    if (accessChecker.length === 0) {
        throw new ConfigError(`The environment variable ${ENV_KEYS.ACCESS_CHECKER} is not set!`);
    }
}

function normalizeProxyTo(url: string): string {
    return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function loadGatewayConfig(env: EnvSource = process.env): GatewayConfig {
    const proxyTo = normalizeProxyTo(requireEnv(env, ENV_KEYS.PROXY_TO));
    const tokenIssuer = requireEnv(env, ENV_KEYS.TOKEN_ISSUER);
    const backendType = parseBackendType(requireEnv(env, ENV_KEYS.BACKEND_TYPE));
    const accessChecker = requireEnv(env, ENV_KEYS.ACCESS_CHECKER).trim();
    const runMode = parseRunMode(env[ENV_KEYS.RUN_MODE]);
    const allowTokenIssuerHostMismatch = parseBooleanEnv(
        env[ENV_KEYS.ALLOW_TOKEN_ISSUER_HOST_MISMATCH],
        ENV_KEYS.ALLOW_TOKEN_ISSUER_HOST_MISMATCH,
        DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH,
    );
    const signingKeySource = parseSigningKeySource(env[ENV_KEYS.SIGNING_KEY_SOURCE]);

    validateAccessChecker(accessChecker, runMode);

    const auditEventActions = parseAuditEventActions(env[ENV_KEYS.AUDIT_EVENT_ACTIONS_CONFIG]);

    const wellKnownEndpoint = env[ENV_KEYS.WELL_KNOWN_ENDPOINT]?.trim() ?? DEFAULT_WELL_KNOWN_ENDPOINT;

    const allowedQueriesFile = env[ENV_KEYS.ALLOWED_QUERIES_FILE]?.trim() ?? undefined;

    const portRaw = env[ENV_KEYS.PORT]?.trim();
    const port = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`Invalid ${ENV_KEYS.PORT}: ${env[ENV_KEYS.PORT]}`);
    }

    const candidate: GatewayConfig = {
        proxyTo,
        tokenIssuer,
        backendType,
        accessChecker,
        auditEventActions,
        wellKnownEndpoint,
        runMode,
        allowTokenIssuerHostMismatch,
        signingKeySource,
        port,
        ...(allowedQueriesFile ? { allowedQueriesFile } : {}),
    };

    const result = GatewayConfigSchema.safeParse(candidate);

    if (!result.success) {
        // 取得 Zod 的第一個錯誤訊息，並格式化成可讀字串（例如 "path: message"）
        const firstError = result.error.issues[0];
        const errorMsg = firstError
            ? `${firstError.path.join(".")}: ${firstError.message}`
            : "Invalid gateway configuration";
        throw new ConfigError(errorMsg);
    }

    return result.data;
}

export function isDevMode(config: GatewayConfig): boolean {
    return config.runMode === "DEV";
}

export function minimalValidEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
    return {
        [ENV_KEYS.PROXY_TO]: "http://localhost:8080/fhir",
        [ENV_KEYS.TOKEN_ISSUER]: "http://localhost:9080/auth/realms/test",
        [ENV_KEYS.BACKEND_TYPE]: "HAPI",
        [ENV_KEYS.ACCESS_CHECKER]: "patient",
        ...overrides,
    };
}

export { BUILTIN_ACCESS_CHECKERS };

