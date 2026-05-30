function formatCause(cause: unknown): string {
    if (cause instanceof Error) {
        return cause.message;
    }
    return String(cause);
}

/** 啟動時無法連線 TOKEN_ISSUER / OIDC discovery 時拋出 */
export class StartupConnectionError extends Error {
    readonly envKey: string;
    readonly url: string;
    readonly attempts: number;

    constructor(envKey: string, url: string, cause: unknown, attempts: number) {
        const detail = formatCause(cause);
        super(`Cannot connect to '${envKey}' at ${url} after ${attempts} attempt(s): ${detail}`);
        this.name = "StartupConnectionError";
        this.envKey = envKey;
        this.url = url;
        this.attempts = attempts;
    }
}
