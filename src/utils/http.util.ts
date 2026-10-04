import { fetch as undiciFetch } from "undici";

import { StartupConnectionError } from "../errors/startup-connection.error";
import { formatErrorMessage } from "./format-error.util";
import { HTTP_NO_CACHE_FETCH_OPTIONS, HTTP_NO_CACHE_HEADERS } from "./http-no-cache.util";
import { retryWithDelays, startupFetchMaxAttempts } from "./retry.util";

export type HttpFetchFn = typeof undiciFetch;

export class HttpUtil {
    constructor(private readonly fetchFn: HttpFetchFn = undiciFetch) {}

    async getText(url: string, options?: { timeoutMs?: number }): Promise<string> {
        const response = await this.fetchFn(url, {
            ...HTTP_NO_CACHE_FETCH_OPTIONS,
            headers: {
                ...HTTP_NO_CACHE_HEADERS,
                "Accept-Charset": "utf-8",
            },
            ...(options?.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Error accessing resource ${url}; status ${response.status}`);
        }

        return response.text();
    }

    /**
     * 啟動階段 fetch：失敗重試，用盡後拋 StartupConnectionError
     */
    async getTextWithStartupRetry(url: string, envKey: string): Promise<string> {
        const maxAttempts = startupFetchMaxAttempts();

        try {
            return await retryWithDelays(
                () => this.getText(url),
                undefined,
                ({ attempt, maxAttempts: total, error, delayMs }) => {
                    console.warn(
                        `Cannot connect to '${envKey}' at ${url} (attempt ${attempt}/${total}): ${formatErrorMessage(error)}. Retrying in ${delayMs / 1000}s...`,
                    );
                },
            );
        } catch (error) {
            throw new StartupConnectionError(envKey, url, error, maxAttempts);
        }
    }

    /** OIDC discovery document at TOKEN_ISSUER + WELL_KNOWN_ENDPOINT */
    async fetchWellKnownConfig(tokenIssuer: string, wellKnownEndpoint: string, envKey: string): Promise<string> {
        const url = joinIssuerPath(tokenIssuer, wellKnownEndpoint);
        return this.getTextWithStartupRetry(url, envKey);
    }
}

export function joinIssuerPath(issuer: string, segment: string): string {
    const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const path = segment.startsWith("/") ? segment.slice(1) : segment;
    return `${base}/${path}`;
}
