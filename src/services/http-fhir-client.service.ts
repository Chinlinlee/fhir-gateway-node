import { request } from "undici";

import type { BackendType } from "../constants/config";

export const RESPONSE_HEADERS_TO_KEEP = new Set<string>([
    "last-modified",
    "date",
    "expires",
    "content-location",
    "content-encoding",
    "etag",
    "location",
    "x-progress",
    "x-request-id",
    "x-correlation-id",
]);

export const REQUEST_HEADERS_TO_KEEP = new Set<string>([
    "content-type",
    "accept-encoding",
    "last-modified",
    "etag",
    "prefer",
    "fhirversion",
    "if-none-exist",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "if-range",
    "x-request-id",
    "x-correlation-id",
    "x-forwarded-for",
    "x-forwarded-host",
]);

export type ForwardRequest = {
    method: string;
    requestPath: string;
    queryParams: Record<string, string[]>;
    headers: Record<string, string[]>;
    body?: Uint8Array;
};

export type ForwardResponse = {
    status: number;
    headers: Headers;
    bodyBytes: Uint8Array;
};

type HttpFhirClientServiceOptions = {
    proxyTo: string;
    backendType: BackendType;
    getGcpAccessToken?: () => Promise<string>;
};

function trimLeadingSlash(value: string): string {
    return value.replace(/^\/+/, "");
}

function buildForwardUrl(baseUrl: string, requestPath: string, queryParams: Record<string, string[]>): string {
    const target = new URL(`${baseUrl}/${trimLeadingSlash(requestPath)}`);
    target.search = "";
    for (const [key, values] of Object.entries(queryParams)) {
        for (const value of values) {
            target.searchParams.append(key, value);
        }
    }
    return target.toString();
}

function normalizeUndiciHeaders(headers: Record<string, string | string[] | undefined>): Headers {
    const result = new Headers();
    for (const [key, value] of Object.entries(headers)) {
        if (value === undefined) {
            continue;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                result.append(key, item);
            }
            continue;
        }
        result.set(key, value);
    }
    return result;
}

export class HttpFhirClientService {
    private readonly proxyTo: string;
    private readonly backendType: BackendType;
    private readonly getGcpAccessToken: (() => Promise<string>) | undefined;

    constructor(options: HttpFhirClientServiceOptions) {
        this.proxyTo = options.proxyTo;
        this.backendType = options.backendType;
        this.getGcpAccessToken = options.getGcpAccessToken;
    }

    async handleRequest(forwardRequest: ForwardRequest): Promise<ForwardResponse> {
        const forwardUrl = buildForwardUrl(this.proxyTo, forwardRequest.requestPath, forwardRequest.queryParams);
        const headers = await this.buildForwardHeaders(forwardRequest.headers);
        const response = await request(forwardUrl, {
            method: forwardRequest.method,
            headers,
            body: forwardRequest.body && forwardRequest.body.length > 0 ? forwardRequest.body : null,
        });
        return {
            status: response.statusCode,
            headers: normalizeUndiciHeaders(response.headers),
            bodyBytes: new Uint8Array(await response.body.arrayBuffer()),
        };
    }

    responseHeadersToKeep(headers: Headers): Headers {
        const kept = new Headers();
        headers.forEach((value, key) => {
            if (RESPONSE_HEADERS_TO_KEEP.has(key.toLowerCase())) {
                kept.append(key, value);
            }
        });
        return kept;
    }

    private async buildForwardHeaders(sourceHeaders: Record<string, string[]>): Promise<Record<string, string>> {
        const headers: Record<string, string> = {};
        for (const [key, values] of Object.entries(sourceHeaders)) {
            const normalizedKey = key.toLowerCase();
            if (normalizedKey === "authorization") {
                continue;
            }
            if (!REQUEST_HEADERS_TO_KEEP.has(normalizedKey)) {
                continue;
            }
            if (values.length === 0) {
                continue;
            }
            headers[key] = values.join(", ");
        }

        if (this.backendType === "GCP") {
            const token = this.getGcpAccessToken ? await this.getGcpAccessToken() : "";
            headers.Authorization = token.length > 0 ? `Bearer ${token}` : "";
            return headers;
        }

        headers.Authorization = "";
        return headers;
    }
}
