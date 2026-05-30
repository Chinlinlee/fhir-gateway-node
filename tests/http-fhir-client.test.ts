import { createServer, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HttpFhirClientService } from "../src/services/http-fhir-client.service";

describe("HttpFhirClientService", () => {
    let server: Server;
    let baseUrl = "";
    let receivedAuthorization = "NOT_CAPTURED";
    let receivedIfMatch = "";

    beforeEach(async () => {
        server = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (req.method === "GET" && url.pathname === "/fhir/Patient/123" && url.searchParams.get("x") === "1") {
                receivedAuthorization = req.headers.authorization ?? "";
                receivedIfMatch = req.headers["if-match"] ?? "";
                res.writeHead(200, { etag: "v1", "x-ignore-me": "value" });
                res.end(JSON.stringify({ resourceType: "Patient", id: "123" }));
                return;
            }
            if (req.method === "GET" && url.pathname === "/fhir/Patient/456" && url.searchParams.get("x") === "2") {
                receivedAuthorization = req.headers.authorization ?? "";
                res.writeHead(200, { etag: "v2" });
                res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Unable to bind http-fhir-client test server");
        }
        baseUrl = `http://127.0.0.1:${address.port}/fhir`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    });

    it("handleRequest forwards allow-listed headers and strips client authorization", async () => {
        const service = new HttpFhirClientService({
            proxyTo: baseUrl,
            backendType: "HAPI",
        });

        const response = await service.handleRequest({
            method: "GET",
            requestPath: "Patient/123",
            queryParams: { x: ["1"] },
            headers: {
                authorization: ["Bearer client-token"],
                "if-match": ['W/"1"'],
                "x-unsupported": ["ignored"],
            },
        });

        expect(response.status).toBe(200);
        expect(receivedAuthorization).toBe("");
        expect(receivedIfMatch).toBe('W/"1"');
        expect(service.responseHeadersToKeep(response.headers).get("etag")).toBe("v1");
        expect(service.responseHeadersToKeep(response.headers).get("x-ignore-me")).toBeNull();
    });

    it("handleRequest forwards GCP bearer token from provider", async () => {
        const service = new HttpFhirClientService({
            proxyTo: baseUrl,
            backendType: "GCP",
            getGcpAccessToken: async () => "gcp-access-token",
        });

        const response = await service.handleRequest({
            method: "GET",
            requestPath: "Patient/456",
            queryParams: { x: ["2"] },
            headers: {
                authorization: ["Bearer client-token-should-be-ignored"],
            },
        });

        expect(response.status).toBe(200);
        expect(receivedAuthorization).toBe("Bearer gcp-access-token");
    });
});
