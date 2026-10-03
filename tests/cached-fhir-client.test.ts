/// <reference types="fhir" />

import { describe, expect, it } from "vitest";

import { CachedFhirClient } from "../src/services/access-checkers/cached-fhir-client";
import type { AsyncFhirClientLike } from "../src/types/http-fhir-client";

/**
 * 後端 stub：記錄同時在飛的查詢數，並回一個帶 marker 的 bundle。
 * 離開 pending 狀態只靠 microtask，因此並行上限完全由 `warm` 決定，不受真實時間影響。
 */
function createCountingBackend() {
    const state = { inFlight: 0, peak: 0, calls: [] as string[] };
    const backend: AsyncFhirClientLike = {
        getResource: async (path) => {
            state.calls.push(path);
            state.inFlight += 1;
            state.peak = Math.max(state.peak, state.inFlight);
            await Promise.resolve();
            state.inFlight -= 1;
            return {
                resourceType: "Bundle",
                type: "searchset",
                total: 1,
                entry: [{ resource: { resourceType: "Patient", id: path } as fhir4.Resource }],
            };
        },
        patchResource: async () => {},
    };
    return { backend, state };
}

describe("CachedFhirClient.warm", () => {
    it("caps how many backend queries a single warm issues at once", async () => {
        const { backend, state } = createCountingBackend();
        const client = new CachedFhirClient(backend);
        const queries = Array.from({ length: 30 }, (_unused, index) => `Patient?_id=p${index}`);

        const resolvedNewQueries = await client.warm(() => {
            for (const query of queries) {
                client.getResource(query);
            }
        });

        expect(resolvedNewQueries).toBe(true);
        // 沒有上限時這裡會是 30（單一 transaction bundle 就能驅動 200+ 次對外請求）
        expect(state.peak).toBeLessThanOrEqual(8);
        expect(state.peak).toBeGreaterThan(1);
        expect(state.calls).toHaveLength(queries.length);
    });

    it("resolves every warmed query from cache instead of the backend", async () => {
        const { backend, state } = createCountingBackend();
        const client = new CachedFhirClient(backend);
        const queries = Array.from({ length: 30 }, (_unused, index) => `Patient?_id=p${index}`);

        await client.warm(() => {
            for (const query of queries) {
                client.getResource(query);
            }
        });
        const afterWarm = state.calls.length;
        const bundles = queries.map((query) => client.getResource(query));

        expect(bundles.map((bundle) => bundle.entry?.[0]?.resource?.id)).toEqual(queries);
        expect(state.calls).toHaveLength(afterWarm);
    });
});
