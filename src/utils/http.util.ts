import { fetch as undiciFetch } from "undici";

import { StartupConnectionError } from "../errors/startup-connection.error";
import { formatErrorMessage } from "./format-error.util";
import { HTTP_NO_CACHE_FETCH_OPTIONS, HTTP_NO_CACHE_HEADERS } from "./http-no-cache.util";
import { retryWithDelays, startupFetchMaxAttempts } from "./retry.util";

export type HttpFetchFn = typeof undiciFetch;

/** 表單 POST 的結果；狀態碼與 body 原文都交給呼叫端判斷。 */
export type HttpFormResponse = {
    status: number;
    body: string;
};

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
     * 以 `application/x-www-form-urlencoded` POST 出去，並回傳狀態碼與 body 原文。
     *
     * 刻意不像 `getText` 那樣對非 2xx 拋錯：OAuth 的錯誤本來就在 body 裡（`invalid_grant`
     * 搭配 400），呼叫端要自己決定怎麼對外回應。
     */
    async postForm(
        url: string,
        form: Record<string, string>,
        options?: { timeoutMs?: number },
    ): Promise<HttpFormResponse> {
        const response = await this.fetchFn(url, {
            method: "POST",
            ...HTTP_NO_CACHE_FETCH_OPTIONS,
            headers: {
                ...HTTP_NO_CACHE_HEADERS,
                "Accept-Charset": "utf-8",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(form).toString(),
            ...(options?.timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.timeoutMs) }),
        });

        return { status: response.status, body: await response.text() };
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
