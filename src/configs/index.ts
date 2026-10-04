import type {
    AuditEventActionCode,
    BackendType,
    LaunchContextStoreType,
    RunMode,
    SigningKeySource,
} from "../constants/config";

import {
    AUDIT_EVENT_ACTION_CODES,
    BUILTIN_ACCESS_CHECKERS,
    DEFAULT_ALLOW_TOKEN_ISSUER_HOST_MISMATCH,
    DEFAULT_INTERNAL_LAUNCH_API_ENABLED,
    DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS,
    DEFAULT_LAUNCH_CONTEXT_STORE,
    DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS,
    DEFAULT_PORT,
    DEFAULT_RUN_MODE,
    DEFAULT_SIGNING_KEY_SOURCE,
    DEFAULT_WELL_KNOWN_ENDPOINT,
    ENV_KEYS,
    LAUNCH_CONTEXT_STORE_TYPES,
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

/**
 * 解析 TOKEN_AUDIENCE：逗號分隔的 `aud` 值清單。全空值等同未設定（不校驗 `aud`），
 * 因此升級既有部署時不會改變任何已接受 token 的結果。
 */
function parseTokenAudience(raw: string | undefined): string[] | undefined {
    const values = (raw ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    return values.length > 0 ? values : undefined;
}

/**
 * 解析未綁定 launch context 的 TTL（秒）。launch id 在被綁定之前只在這段時間內有效，
 * 過期後 `authorize` 帶著它進來時一律視為不存在。
 */
function parseLaunchContextTtlSeconds(raw: string | undefined): number {
    const value = raw?.trim();
    if (value === undefined || value.length === 0) {
        return DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS;
    }

    const ttl = Number.parseInt(value, 10);
    if (!Number.isInteger(ttl) || ttl < 1) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.LAUNCH_CONTEXT_TTL_SECONDS} must be a positive integer number of seconds (got: ${raw})`,
        );
    }

    return ttl;
}

/**
 * 解析**已綁定** launch context 的 TTL（秒）。與未綁定的 TTL 分開設定：未綁定那段是
 * 「EHR 還沒讓使用者按下同意」的一個短視窗，綁定後那段是「醫師處理這位病人」的時長，
 * 兩者的合理長度差了三個數量級（spec Module 6：已綁定與未綁定可以不同）。
 */
function parseLaunchContextBoundTtlSeconds(raw: string | undefined): number {
    const value = raw?.trim();
    if (value === undefined || value.length === 0) {
        return DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS;
    }

    const ttl = Number.parseInt(value, 10);
    if (!Number.isInteger(ttl) || ttl < 1) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.LAUNCH_CONTEXT_BOUND_TTL_SECONDS} must be a positive integer number of seconds (got: ${raw})`,
        );
    }

    return ttl;
}

/**
 * launch context store 的實作選擇。空字串等同未設定，因此 `LAUNCH_CONTEXT_STORE=` 走預設值
 * 而不是報錯——`env.example` 裡那行就是空的。
 */
function parseLaunchContextStoreType(raw: string | undefined): LaunchContextStoreType {
    const value = raw?.trim().toLowerCase();
    if (value === undefined || value.length === 0) {
        return DEFAULT_LAUNCH_CONTEXT_STORE;
    }
    if (LAUNCH_CONTEXT_STORE_TYPES.includes(value as LaunchContextStoreType)) {
        return value as LaunchContextStoreType;
    }
    throw new ConfigError(
        `The environment variable ${ENV_KEYS.LAUNCH_CONTEXT_STORE} must be memory or valkey (got: ${raw})`,
    );
}

/**
 * Valkey 連線 URL。選了 valkey 卻沒給 URL，gateway 啟動時無從連線，而 store 故障對
 * patient／list 模式等同 401——因此這裡在啟動期就失敗並指名環境變數，與 IdP 的處理一致。
 */
function parseLaunchContextValkeyUrl(raw: string | undefined, storeType: LaunchContextStoreType): string | undefined {
    const url = raw?.trim();

    if (storeType !== "valkey") {
        return undefined;
    }

    if (url === undefined || url.length === 0) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL} must be set when ${ENV_KEYS.LAUNCH_CONTEXT_STORE} is valkey!`,
        );
    }

    return url;
}

/**
 * 內部 launch context 端點的憑證必須在端點啟用時存在：端點一旦啟用卻沒有認證，
 * 等於對外開了一個任何人都能註冊 PHI 的入口。啟動即失敗並指名環境變數，
 * 讓 operator 不用從 log 猜哪個變數漏了。
 */
function parseInternalLaunchApiCredential(raw: string | undefined, enabled: boolean): string | undefined {
    const credential = raw?.trim();

    if (!enabled) {
        return undefined;
    }

    if (credential === undefined || credential.length === 0) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.INTERNAL_LAUNCH_API_CREDENTIAL} must be set when ${ENV_KEYS.INTERNAL_LAUNCH_API_ENABLED} is true!`,
        );
    }

    return credential;
}

/**
 * gateway 作為 client 存取 IdP token endpoint 的憑證。設定 `GATEWAY_PUBLIC_BASE_URL` 就等同
 * 啟用代理的授權流程，而這條流程在 callback 時一定要拿 client 憑證去換 token——缺憑證的
 * 部署只會在第一個使用者登入時才炸。啟動即失敗並指名環境變數。
 *
 * gateway 仍然不簽任何 token：這組憑證只證明「是 gateway 在問 IdP 要 token」，
 * 簽發權與 access token 都在 IdP 手上（ADR-0001）。
 */
function parseGatewayIdpClientCredentials(
    clientIdRaw: string | undefined,
    clientSecretRaw: string | undefined,
    publicBaseUrl: string | undefined,
): { gatewayClientId?: string; gatewayClientSecret?: string } {
    if (publicBaseUrl === undefined) {
        return {};
    }

    const clientId = clientIdRaw?.trim();
    if (clientId === undefined || clientId.length === 0) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.GATEWAY_CLIENT_ID} must be set when ${ENV_KEYS.GATEWAY_PUBLIC_BASE_URL} is configured!`,
        );
    }

    const clientSecret = clientSecretRaw?.trim();
    if (clientSecret === undefined || clientSecret.length === 0) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.GATEWAY_CLIENT_SECRET} must be set when ${ENV_KEYS.GATEWAY_PUBLIC_BASE_URL} is configured!`,
        );
    }

    return { gatewayClientId: clientId, gatewayClientSecret: clientSecret };
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

    const tokenAudience = parseTokenAudience(env[ENV_KEYS.TOKEN_AUDIENCE]);

    const internalLaunchApiEnabled = parseBooleanEnv(
        env[ENV_KEYS.INTERNAL_LAUNCH_API_ENABLED],
        ENV_KEYS.INTERNAL_LAUNCH_API_ENABLED,
        DEFAULT_INTERNAL_LAUNCH_API_ENABLED,
    );
    // 憑證檢查在解析層完成：啟用而未設定憑證的部署必須在啟動時就失敗，而不是等第一個請求。
    const internalLaunchApiCredential = parseInternalLaunchApiCredential(
        env[ENV_KEYS.INTERNAL_LAUNCH_API_CREDENTIAL],
        internalLaunchApiEnabled,
    );

    const launchContextTtlSeconds = parseLaunchContextTtlSeconds(env[ENV_KEYS.LAUNCH_CONTEXT_TTL_SECONDS]);

    const launchContextBoundTtlSeconds = parseLaunchContextBoundTtlSeconds(
        env[ENV_KEYS.LAUNCH_CONTEXT_BOUND_TTL_SECONDS],
    );

    const launchContextStoreType = parseLaunchContextStoreType(env[ENV_KEYS.LAUNCH_CONTEXT_STORE]);
    const launchContextValkeyUrl = parseLaunchContextValkeyUrl(
        env[ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL],
        launchContextStoreType,
    );

    // 端點改寫絕不從請求的 Host 推導：operator 設定的 base URL 是唯一權威來源。
    const gatewayPublicBaseUrl = env[ENV_KEYS.GATEWAY_PUBLIC_BASE_URL]?.trim();
    const { gatewayClientId, gatewayClientSecret } = parseGatewayIdpClientCredentials(
        env[ENV_KEYS.GATEWAY_CLIENT_ID],
        env[ENV_KEYS.GATEWAY_CLIENT_SECRET],
        gatewayPublicBaseUrl === undefined || gatewayPublicBaseUrl.length === 0 ? undefined : gatewayPublicBaseUrl,
    );

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
        ...(tokenAudience ? { tokenAudience } : {}),
        ...(internalLaunchApiCredential ? { internalLaunchApiCredential } : {}),
        internalLaunchApiEnabled,
        launchContextTtlSeconds,
        launchContextStoreType,
        launchContextBoundTtlSeconds,
        ...(launchContextValkeyUrl ? { launchContextValkeyUrl } : {}),
        ...(gatewayPublicBaseUrl ? { gatewayPublicBaseUrl } : {}),
        ...(gatewayClientId && gatewayClientSecret ? { gatewayClientId, gatewayClientSecret } : {}),
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
