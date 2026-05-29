import { describe, expect, it } from "vitest";

import { createTestClient } from "./helpers/eden";

describe("app", () => {
    it("GET /health returns ok without mocks", async () => {
        const { client } = createTestClient();
        const { data, status } = await client.health.get();

        expect(status).toBe(200);
        expect(data).toEqual({ status: "ok" });
    });
});
