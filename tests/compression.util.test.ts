import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { applyGzipResponseHeaders, decodeCompressedBody } from "../src/utils/compression.util";

describe("compression.util", () => {
    it("decodeCompressedBody gunzips upstream body", () => {
        const payload = JSON.stringify({ resourceType: "Bundle", total: 2 });
        const compressed = gzipSync(Buffer.from(payload, "utf8"));

        const decoded = decodeCompressedBody(compressed, "gzip");
        expect(Buffer.from(decoded).toString("utf8")).toBe(payload);
    });

    it("decodeCompressedBody returns original bytes when not compressed", () => {
        const payload = new TextEncoder().encode('{"resourceType":"Patient"}');
        expect(decodeCompressedBody(payload, null)).toEqual(payload);
    });

    it("applyGzipResponseHeaders sets content-length and removes transfer-encoding", () => {
        const headers = new Headers({
            "content-encoding": "gzip",
            "transfer-encoding": "chunked",
        });

        applyGzipResponseHeaders(headers, 128);

        expect(headers.get("content-encoding")).toBe("gzip");
        expect(headers.get("content-length")).toBe("128");
        expect(headers.get("transfer-encoding")).toBeNull();
    });
});
