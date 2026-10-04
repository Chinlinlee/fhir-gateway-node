import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FhirBackendService } from "../src/services/fhir-backend.service";

describe("FhirBackendService", () => {
    let server: Server;
    let baseUrl = "";

    beforeEach(async () => {
        server = createServer((req, res) => {
            const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
            if (
                req.method === "GET" &&
                requestUrl.pathname === "/fhir/List" &&
                requestUrl.searchParams.get("_id") === "L1"
            ) {
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "Bundle", total: 1, entry: [] }));
                return;
            }

            if (req.method === "PATCH" && requestUrl.pathname === "/fhir/List/L1") {
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "List", id: "L1" }));
                return;
            }

            res.writeHead(404, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Failed to bind fhir backend test server");
        }
        baseUrl = `http://127.0.0.1:${address.port}/fhir`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    });

    it("getResource and patchResource work with fhir-kit-client", async () => {
        const backend = new FhirBackendService({ baseUrl });

        const bundle = await backend.getResource("/List?_id=L1");
        await backend.patchResource("List/L1", JSON.stringify([{ op: "add", path: "/entry/-", value: {} }]));

        expect(bundle.resourceType).toBe("Bundle");
        expect(bundle.total).toBe(1);
    });
});
