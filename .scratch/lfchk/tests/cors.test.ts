import { describe, expect, it } from "vitest";

import { createTestClient } from "./helpers/eden";

describe("cors", () => {
    it("responds to OPTIONS with CORS headers", async () => {
        const { app } = createTestClient();
        const response = await app.handle(
            new Request("http://localhost/health", {
                method: "OPTIONS",
                headers: {
                    Origin: "http://example.com",
                    "Access-Control-Request-Method": "GET",
                    "Access-Control-Request-Headers": "authorization",
                },
            }),
        );

        expect(response.status).toBeLessThan(300);
        expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    });
});
