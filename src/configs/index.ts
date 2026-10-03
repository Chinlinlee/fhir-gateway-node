import {
    CLAIM_NAME_FIELDS,
    type ClaimNames,
    isClaimNameField,
    STRUCTURAL_CLAIM_NAMES,
} from "../constants/claim-names";
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

/**
 * 解析 `TOKEN_CLAIM_NAMES`：邏輯欄位名 → claim 名稱的 JSON 物件。
 *
 * 啟動期驗證：格式錯誤、未知邏輯欄位、空 claim 名稱，或把結構性 claim（`iss` / `sub`）
 * 當成可設定欄位，都在此擋下並在訊息中指名設定，讓啟動直接失敗。
 *
 * 注意：這個設定**無法**在啟動時驗證「某個 claim 名稱是否出現在 IdP 發出的 token」——
 * 啟動時沒有 token。該層檢查在第一個 token 驗證後進行，見 launch context provider。
 */
function parseClaimNames(raw: string | undefined): Partial<ClaimNames> | undefined {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.CLAIM_NAMES} must be valid JSON (got: ${raw})`,
        );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ConfigError(
            `The environment variable ${ENV_KEYS.CLAIM_NAMES} must be a JSON object mapping logical field ` +
                `names to claim names (got: ${raw})`,
        );
    }

    const claimNames: Partial<ClaimNames> = {};
    for (const [field, claim] of Object.entries(parsed)) {
        if (!isClaimNameField(field)) {
            throw new ConfigError(
                `The environment variable ${ENV_KEYS.CLAIM_NAMES} has unknown logical field '${field}' ` +
                    `(allowed: ${CLAIM_NAME_FIELDS.join(", ")})`,
            );
        }
        if (typeof claim !== "string" || claim.trim().length === 0) {
            throw new ConfigError(
                `The environment variable ${ENV_KEYS.CLAIM_NAMES}.${field} must be a non-empty claim name`,
            );
        }
        const normalized = claim.trim();
        if ((STRUCTURAL_CLAIM_NAMES as readonly string[]).includes(normalized)) {
            throw new ConfigError(
                `The environment variable ${ENV_KEYS.CLAIM_NAMES}.${field} may not use the structural claim ` +
                    `'${normalized}' (${STRUCTURAL_CLAIM_NAMES.join(", ")} are defined by the gateway itself)`,
            );
        }
        claimNames[field as keyof ClaimNames] = normalized;
    }

    return Object.keys(claimNames).length > 0 ? claimNames : undefined;
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

    // 啟動期驗證：設定結構錯誤時立即失敗，不進入 listen
    const claimNames = parseClaimNames(env[ENV_KEYS.CLAIM_NAMES]);

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
        ...(claimNames ? { claimNames } : {}),
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

