import { createServer, type Server } from "node:http";

import type { CryptoKey, JWTPayload } from "jose";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { AuditEventService } from "../src/services/audit-event.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

type PostCall = {
    resource: fhir4.Resource;
};

type UpstreamServer = {
    baseUrl: string;
    getAuditCount: () => number;
    close: () => Promise<void>;
};

function baseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
    return {
        proxyTo: "http://127.0.0.1:0/fhir",
        tokenIssuer: "http://issuer",
        backendType: "HAPI",
        accessChecker: "patient",
        auditEventActions: ["R"],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        ...overrides,
    };
}

async function signJwt(issuer: string, privateKey: CryptoKey, claims: Record<string, string>): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setSubject("audit-user")
        .setJti("jwt-id-1")
        .sign(privateKey);
}

async function startAuditUpstreamServer(auditPostStatus = 201): Promise<UpstreamServer> {
    let auditCount = 0;
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/fhir/AuditEvent") {
            auditCount += 1;
            res.writeHead(auditPostStatus, { "content-type": "application/fhir+json" });
            res.end(
                JSON.stringify({
                    resourceType: "OperationOutcome",
                    issue: [{ severity: "information", code: "informational" }],
                }),
            );
            return;
        }

        res.writeHead(404, { "content-type": "application/fhir+json" });
        res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to start audit upstream server");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        getAuditCount: () => auditCount,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

describe("AuditEventService", () => {
    it("logs AuditEvent when action is configured", async () => {
        const posts: PostCall[] = [];
        const service = new AuditEventService({
            postResource: async (resource) => {
                posts.push({ resource });
                return resource;
            },
        });

        await service.log({
            request: {
                requestPath: "Patient/123",
                requestType: "GET",
                queryParams: {},
            },
            responseStatus: 200,
            responseBody: JSON.stringify({ resourceType: "Patient", id: "123" }),
            responseHeaders: new Headers({ "content-location": "http://upstream/fhir/Patient/123/_history/1" }),
            userWho: {
                resourceType: "Practitioner",
                display: "Dr. Smith",
                identifier: { system: "http://issuer", value: "user-1" },
            },
            jwtPayload: {
                sub: "user-1",
                azp: "test-app",
                jti: "jwt-id",
            } as JWTPayload,
            gatewayBaseUrl: "http://gateway/fhir",
            configuredActions: ["R"],
        });

        expect(posts.length).toBe(1);
        const auditEvent = posts[0]?.resource as fhir4.AuditEvent;
        expect(auditEvent.resourceType).toBe("AuditEvent");
        expect(auditEvent.action).toBe("R");
        expect(auditEvent.subtype?.[0]?.code).toBe("read");
        expect(auditEvent.agent?.[0]?.who?.display).toBe("Dr. Smith");
        expect(auditEvent.source?.observer?.display).toBe("http://gateway/fhir");
        expect(auditEvent.entity?.[0]?.what?.reference).toContain("Patient/123/_history/1");
    });

    it("skips logging when action is not configured", async () => {
        const posts: PostCall[] = [];
        const service = new AuditEventService({
            postResource: async (resource) => {
                posts.push({ resource });
                return resource;
            },
        });

        await service.log({
            request: {
                requestPath: "Patient/123",
                requestType: "GET",
                queryParams: {},
            },
            responseStatus: 200,
            responseBody: "{}",
            responseHeaders: new Headers(),
            userWho: {
                resourceType: "Practitioner",
                display: "No Audit",
            },
            jwtPayload: {} as JWTPayload,
            gatewayBaseUrl: "http://gateway/fhir",
            configuredActions: ["C"],
        });

        expect(posts.length).toBe(0);
    });
});

describe("Audit event proxy integration", () => {
    let issuer: IssuerTestServer | null = null;
    let upstream: UpstreamServer | null = null;

    afterEach(async () => {
        if (issuer) {
            await issuer.close();
            issuer = null;
        }
        if (upstream) {
            await upstream.close();
            upstream = null;
        }
    });

    it("posts AuditEvent when audit config and userWho are present", async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startAuditUpstreamServer(201);
        const tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
        const app = createApp({
            tokenVerifier,
            config: baseConfig({
                tokenIssuer: issuer.issuerUrl,
                proxyTo: upstream.baseUrl,
                auditEventActions: ["R"],
            }),
        });
        const jwt = await signJwt(issuer.issuerUrl, issuer.keys.privateKey, {
            patient: "456",
            scope: "patient/Patient.read",
            name: "Audit User",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
        expect(upstream.getAuditCount()).toBe(1);
    });

    it("does not fail request when posting AuditEvent fails", async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startAuditUpstreamServer(500);
        const tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
        const app = createApp({
            tokenVerifier,
            config: baseConfig({
                tokenIssuer: issuer.issuerUrl,
                proxyTo: upstream.baseUrl,
                auditEventActions: ["R"],
            }),
        });
        const jwt = await signJwt(issuer.issuerUrl, issuer.keys.privateKey, {
            patient: "456",
            scope: "patient/Patient.read",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
        expect(upstream.getAuditCount()).toBe(1);
    });
});
