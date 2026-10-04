import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

function parseContentEncodings(contentEncoding: string | null): string[] {
    if (!contentEncoding) {
        return [];
    }
    return contentEncoding
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length > 0 && part !== "identity");
}

/** 依 Content-Encoding 解壓 upstream body，供文字後處理使用 / Decode upstream body before UTF-8 post-processing */
export function decodeCompressedBody(bodyBytes: Uint8Array, contentEncoding: string | null): Uint8Array {
    if (bodyBytes.length === 0) {
        return bodyBytes;
    }

    const encodings = parseContentEncodings(contentEncoding);
    if (encodings.length === 0) {
        return bodyBytes;
    }

    let decoded = bodyBytes;
    for (let index = encodings.length - 1; index >= 0; index -= 1) {
        const encoding = encodings[index];
        if (encoding === "gzip" || encoding === "x-gzip") {
            decoded = gunzipSync(decoded);
            continue;
        }
        if (encoding === "deflate") {
            decoded = inflateSync(decoded);
            continue;
        }
        if (encoding === "br") {
            decoded = brotliDecompressSync(decoded);
        }
    }
    return decoded;
}

/** 設定 content-length，避免 Elysia 以 TextDecoder 串流 gzip 二進位 / Set length so Elysia keeps gzip bytes intact */
export function applyGzipResponseHeaders(responseHeaders: Headers, gzipBodyLength: number): void {
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.set("content-encoding", "gzip");
    responseHeaders.set("content-length", String(gzipBodyLength));
}
