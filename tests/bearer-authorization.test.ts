import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";

import { type CryptoKey, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { createDefaultAccessCheckerRegistry } from "../src/services/access-checker-registry.service";
import { PATIENT_CLAIM } from "../src/services/access-checkers/patient-access-checker.service";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import type { AccessChecker, AccessCheckerFactory } from "../src/types/access-checker";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

type UpstreamServer = {
    baseUrl: string;
    close: () => Promise<void>;
};

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
    claims: Record<string, string>,
): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setSubject("gateway-user")
        .sign(privateKey);
}

async function startUpstreamServer(): Promise<UpstreamServer> {
    let fhirStoreBase = "";
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json", etag: "W/1" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Observation/enc-1") {
            if (url.searchParams.get("patient") === "Patient/456") {
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "Observation", id: "enc-1" }));
                return;
            }
            res.writeHead(403, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/metadata") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "CapabilityStatement", rest: [{}] }));
            return;
        }

        if (
            req.method === "GET" &&
            url.pathname === "/fhir/Composition" &&
            url.searchParams.get("_getpages") === "A_PAGE_ID"
        ) {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Bundle", total: 1 }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Patient" && url.searchParams.get("_id") === "456") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(
                JSON.stringify({
                    resourceType: "Bundle",
                    entry: [{ fullUrl: `${fhirStoreBase}/Patient/456` }],
                }),
            );
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/mutation-check") {
            if (url.searchParams.get("added") === "true" && !url.searchParams.has("discard")) {
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "Bundle", total: 1 }));
                return;
            }
            res.writeHead(400, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
            return;
        }

        res.writeHead(404, { "content-type": "application/fhir+json" });
        res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Unable to bind upstream test server");
    }
    fhirStoreBase = `http://127.0.0.1:${address.port}/fhir`;

    return {
        baseUrl: fhirStoreBase,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

describe("Bearer authorization proxy flow", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;

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

    it("authorizeRequestPatient / authorizeRequestMetadata / authorizeAllowedUnauthenticatedRequest", async () => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            allowedQueriesFile: allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
        });
        const app = createApp({
            tokenVerifier,
            config,
            allowedQueries: AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
            patientFinder: PatientFinderService.getInstance(),
        });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [PATIENT_CLAIM]: "456",
            scope: "patient/Patient.read patient/Observation.read",
        });

        const patientResponse = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );
        const metadataResponse = await app.handle(new Request(`http://localhost${FHIR_API_PREFIX}/metadata`));
        const allowUnauthResponse = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Composition?_getpages=A_PAGE_ID`),
        );

        expect(patientResponse.status).toBe(200);
        expect(((await patientResponse.json()) as { id: string }).id).toBe("456");
        expect(metadataResponse.status).toBe(200);
        const metadataBody = (await metadataResponse.json()) as {
            rest: Array<{ security?: { cors?: boolean; service?: Array<{ coding?: Array<{ code?: string }> }> } }>;
        };
        expect(metadataBody.rest[0]?.security?.cors).toBe(true);
        expect(metadataBody.rest[0]?.security?.service?.[0]?.coding?.[0]?.code).toBe("OAuth");
        expect(allowUnauthResponse.status).toBe(200);
    });

    it("authorizeRequestTestReplaceUrl and deniedRequest", async () => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
        });
        const app = createApp({ tokenVerifier, config });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [PATIENT_CLAIM]: "456",
            scope: "patient/Patient.read",
        });

        const replacedResponse = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient?_id=456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        const replacedText = await replacedResponse.text();
        expect(replacedResponse.status).toBe(200);
        expect(replacedText).toContain("http://localhost/fhir/Patient/456");

        const deniedResponse = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/123`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );
        expect(deniedResponse.status).toBe(403);
        const deniedBody = (await deniedResponse.json()) as { issue?: Array<{ code?: string }> };
        expect(deniedBody.issue?.[0]?.code).toBe("forbidden");
    });

    it("mutateRequest / mutateRequestRemoveQueryParams and gzip response", async () => {
        const mutationFactory: AccessCheckerFactory = {
            create: (): AccessChecker => ({
                checkAccess: () => ({
                    canAccess: () => true,
                    getRequestMutation: () => ({
                        additionalQueryParams: { added: ["true"] },
                        discardQueryParams: ["discard"],
                    }),
                    postProcess: () => null,
                    getUserWho: () => null,
                }),
            }),
        };
        const registry = createDefaultAccessCheckerRegistry();
        registry.register("test-mutation", mutationFactory);

        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            accessChecker: "test-mutation",
        });
        const app = createApp({
            tokenVerifier,
            config,
            accessCheckerRegistry: registry,
        });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/*.*",
            [PATIENT_CLAIM]: "456",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/mutation-check?discard=1`, {
                headers: {
                    Authorization: `Bearer ${jwt}`,
                    "Accept-Encoding": "gzip, deflate",
                },
            }),
        );

        expect(response.status).toBe(200);
        expect(response.headers.get("content-encoding")).toBe("gzip");
        expect(response.headers.get("content-length")).not.toBeNull();

        const gzipBody = Buffer.from(await response.arrayBuffer());
        expect(gzipBody[0]).toBe(0x1f);
        expect(gzipBody[1]).toBe(0x8b);
        const body = JSON.parse(gunzipSync(gzipBody).toString("utf8")) as { resourceType: string; total: number };
        expect(body.resourceType).toBe("Bundle");
        expect(body.total).toBe(1);
    });

    it("injects patient query for direct non-Patient read when ACCESS_CHECKER=patient", async () => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            accessChecker: "patient",
        });
        const app = createApp({ tokenVerifier, config });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            [PATIENT_CLAIM]: "456",
            scope: "patient/Observation.read",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Observation/enc-1`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
        expect(((await response.json()) as { id: string }).id).toBe("enc-1");
    });

    it("returns 401 naming the missing launch context patient id for patient-mode token without patient", async () => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            accessChecker: "patient",
        });
        const app = createApp({ tokenVerifier, config });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/Patient.read",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(401);
        const body = (await response.json()) as { issue?: Array<{ diagnostics?: string }> };
        expect(body.issue?.[0]?.diagnostics).toContain("patientId");
    });

    it("basic checker authorizes from launch context scopes", async () => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            accessChecker: "basic",
        });
        const app = createApp({ tokenVerifier, config });
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, {
            scope: "patient/Patient.read",
        });

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );

        expect(response.status).toBe(200);
    });
});
