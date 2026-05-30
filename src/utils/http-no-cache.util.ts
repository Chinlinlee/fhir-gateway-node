export const HTTP_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    Pragma: "no-cache",
} as const;

export const HTTP_NO_CACHE_FETCH_OPTIONS = {
    cache: "no-store",
} as const;

export function withNoCacheHeaders(headers: Record<string, string>): Record<string, string> {
    return {
        ...headers,
        ...HTTP_NO_CACHE_HEADERS,
    };
}
