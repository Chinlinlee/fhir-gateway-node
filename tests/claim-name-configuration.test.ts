/// <reference types="fhir" />

import { createServer, type Server } from "node:http";
import { type CryptoKey, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { type ClaimNames, DEFAULT_CLAIM_NAMES } from "../src/constants/claim-names";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { AuditEventService } from "../src/services/audit-event.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

type UpstreamServer = { baseUrl: string; close: () => Promise<void> };

function createBaseConfig(overrides: Partial<GatewayConfig>): GatewayConfig {
    return {
        proxyTo: "http://127.0.0.1:0/fhir",
        tokenIssuer: "http://token-issuer",
        backendType: "HAPI",
        accessChecker: "patient",
        auditEventActions: [],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        ...overrides,
    };
}

async function signJwtWithClaims(
    issuer: string,
    privateKey: CryptoKey,
    claims: Record<string, unknown>,
): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setSubject("gateway-user")
        .sign(privateKey);
}

/** List 模式：patient-list 內含 Patient/456，不含 Patient/999。 */
async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        const fhirJson = { "content-type": "application/fhir+json" };

        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, fhirJson);
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Patient/999") {
            res.writeHead(200, fhirJson);
            res.end(JSON.stringify({ resourceType: "Patient", id: "999" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Observation/enc-1") {
            // patient 查詢參數必須由 launch context 注入，值與 checker 授權的是同一個 patient
            if (url.searchParams.get("patient") === "Patient/456") {
                res.writeHead(200, fhirJson);
                res.end(JSON.stringify({ resourceType: "Observation", id: "enc-1" }));
                return;
            }
            res.writeHead(403, fhirJson);
            res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
            return;
        }

        // List membership query：item=Patient/456 在清單內，Patient/999 不在
        if (req.method === "GET" && url.pathname === "/fhir/List") {
            const item = url.searchParams.get("item");
            const inList = item?.includes("Patient%2F456") || item?.includes("Patient/456");
            res.writeHead(200, fhirJson);
            res.end(JSON.stringify({ resourceType: "Bundle", total: inList ? 1 : 0 }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/fhir/AuditEvent") {
            res.writeHead(201, fhirJson);
            res.end(JSON.stringify({ resourceType: "AuditEvent", id: "audit-1" }));
            return;
        }

        res.writeHead(404, fhirJson);
        res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to bind upstream test server");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

describe("Claim name configuration over the app seam", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;

    /** 以指定的 claim 名稱設定組出真實的 app。 */
    function buildApp(claimNames: Partial<ClaimNames> | undefined, overrides: Partial<GatewayConfig> = {}): App {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            ...(claimNames ? { claimNames } : {}),
            ...overrides,
        });
        return createApp({ tokenVerifier, config, patientFinder: PatientFinderService.getInstance() });
    }

    function get(app: App, path: string, jwt: string): Promise<Response> {
        return app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}${path}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );
    }

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    it("authorizes a patient reference carried under a non-default configured claim name exactly as under the default name", async () => {
        const defaultApp = buildApp(undefined);
        const configuredApp = buildApp({ patient: "fhir_patient" });

        const defaultToken = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patient]: "456",
            scope: "patient/Patient.read patient/Observation.read",
        });
        const configuredToken = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            fhir_patient: "456",
            scope: "patient/Patient.read patient/Observation.read",
        });

        for (const [app, jwt] of [
            [defaultApp, defaultToken],
            [configuredApp, configuredToken],
        ] as const) {
            expect((await get(app, "/Patient/456", jwt)).status).toBe(200);
            expect((await get(app, "/Patient/999", jwt)).status).toBe(403);
            // injection 與 checker 共用同一個 patient，因此非 Patient read 也能通過
            expect((await get(app, "/Observation/enc-1", jwt)).status).toBe(200);
        }
    });

    it("ignores the default patient claim name once a non-default name is configured", async () => {
        const app = buildApp({ patient: "fhir_patient" });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patient]: "456",
            scope: "patient/Patient.read",
        });

        const response = await get(app, "/Patient/456", jwt);
        expect(response.status).toBe(401);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("patientId");
    });

    it("authorizes a patient-list reference under a non-default configured claim name exactly as under the default name", async () => {
        const listMode = { accessChecker: "list" } satisfies Partial<GatewayConfig>;
        const defaultApp = buildApp(undefined, listMode);
        const configuredApp = buildApp({ patientList: "fhir_list" }, listMode);

        const defaultToken = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patientList]: "list-1",
        });
        const configuredToken = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            fhir_list: "list-1",
        });

        for (const [app, jwt] of [
            [defaultApp, defaultToken],
            [configuredApp, configuredToken],
        ] as const) {
            expect((await get(app, "/Patient/456", jwt)).status).toBe(200);
            expect((await get(app, "/Patient/999", jwt)).status).toBe(403);
        }
    });

    it("resolves scopes delivered under a non-default configured scope claim name", async () => {
        const app = buildApp({ scopesSpaceDelimited: "fhir_scopes" });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patient]: "456",
            fhir_scopes: "patient/Patient.read",
        });

        expect((await get(app, "/Patient/456", jwt)).status).toBe(200);
        expect((await get(app, "/Patient/999", jwt)).status).toBe(403);
    });

    it("fails with a 500 naming the setting when a configured claim name appears in no token", async () => {
        const app = buildApp({ patient: "fhir_patient", patientList: "fhir_list", scopesSpaceDelimited: "fhir_scopes" });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/Patient.read",
            patient: "456",
            patient_list: "list-1",
        });

        const response = await get(app, "/Patient/456", jwt);

        expect(response.status).toBe(500);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("TOKEN_CLAIM_NAMES");
    });

    it("keeps the 401 contract for a patient-mode token that legitimately lacks the configured patient claim", async () => {
        const app = buildApp({ patient: "fhir_patient" });
        // scope claim 使用預設名稱，因此設定是有效的；只是這個 token 沒有 patient claim
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/Patient.read",
        });

        const response = await get(app, "/Patient/456", jwt);

        expect(response.status).toBe(401);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("patientId");
    });

    it("leaves a token that carries none of the default claim names untouched when the setting is absent", async () => {
        const app = buildApp(undefined);
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/Patient.read",
        });

        const response = await get(app, "/Patient/456", jwt);

        expect(response.status).toBe(401);
    });

    it("records subject_name as the audit display name when the token also carries name", async () => {
        const posted: fhir4.Resource[] = [];
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            auditEventActions: ["R"],
        });
        const app = createApp({
            tokenVerifier,
            config,
            patientFinder: PatientFinderService.getInstance(),
            auditEventService: new AuditEventService({
                postResource: async (resource) => {
                    posted.push(resource);
                    return resource;
                },
            }),
        });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patient]: "456",
            scope: "patient/Patient.read",
            subject_name: "IHE Name",
            name: "OIDC Name",
        });

        expect((await get(app, "/Patient/456", jwt)).status).toBe(200);

        expect(posted).toHaveLength(1);
        const auditEvent = posted[0] as fhir4.AuditEvent;
        expect(auditEvent.agent?.[0]?.who?.display).toBe("IHE Name");
    });

    it("falls back to name when the token carries no subject_name", async () => {
        const posted: fhir4.Resource[] = [];
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            auditEventActions: ["R"],
        });
        const app = createApp({
            tokenVerifier,
            config,
            patientFinder: PatientFinderService.getInstance(),
            auditEventService: new AuditEventService({
                postResource: async (resource) => {
                    posted.push(resource);
                    return resource;
                },
            }),
        });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [DEFAULT_CLAIM_NAMES.patient]: "456",
            scope: "patient/Patient.read",
            name: "OIDC Name",
        });

        expect((await get(app, "/Patient/456", jwt)).status).toBe(200);

        expect(posted).toHaveLength(1);
        const auditEvent = posted[0] as fhir4.AuditEvent;
        expect(auditEvent.agent?.[0]?.who?.display).toBe("OIDC Name");
    });
});