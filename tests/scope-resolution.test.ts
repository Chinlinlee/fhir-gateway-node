import { createServer, type Server } from "node:http";

import { type CryptoKey, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import { seedLaunchContextForToken } from "./helpers/launch-context-fixture";

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
    claims: Record<string, unknown>,
): Promise<string> {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(issuer)
        .setSubject("gateway-user")
        .sign(privateKey);
}

async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Observation/enc-1") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Observation", id: "enc-1" }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/fhir/Observation") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Bundle", total: 0 }));
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

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

describe("Scope resolution over the app seam", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let config: GatewayConfig;
    let app: App;
    // 病人參照改由 launch context store 提供：測試自簽 token，因此 app 與 seed 共用同一份 store。
    let launchContextStore: InMemoryLaunchContextStore;

    const PATIENT_ID = "456";

    /**
     * 病人參照只存在於 launch context store；token 靠 `jti` 找回那份綁定，因此每張自簽的
     * token 都配一個獨立的 launch context。
     */
    async function signPatientToken(claims: Record<string, unknown>, tokenId: string): Promise<string> {
        const jwt = await signJwtWithClaims(issuer.issuerUrl, issuer.keys.privateKey, { jti: tokenId, ...claims });
        await seedLaunchContextForToken(
            launchContextStore,
            { subject: "gateway-user", clientId: "test-app", tokenId },
            { patientId: PATIENT_ID },
        );
        return jwt;
    }

    /** 以 `scope` 空白分隔字串交付 SMART scopes。 */
    function tokenWithScopeString(scopes: string, tokenId: string): Promise<string> {
        return signPatientToken({ scope: scopes }, tokenId);
    }

    /** 以 RFC 9068 `scp` 陣列交付 SMART scopes。 */
    function tokenWithScpArray(scopes: string[], tokenId: string): Promise<string> {
        return signPatientToken({ scp: scopes }, tokenId);
    }

    function get(path: string, jwt: string): Promise<Response> {
        return app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}${path}`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );
    }

    function remove(path: string, jwt: string): Promise<Response> {
        return app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}${path}`, {
                method: "DELETE",
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
        launchContextStore = new InMemoryLaunchContextStore();
        config = createBaseConfig({ tokenIssuer: issuer.issuerUrl, proxyTo: upstream.baseUrl });
        app = createApp({
            tokenVerifier,
            config,
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore,
        });
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    it("accepts the same scopes from the space-delimited scope string and from the scp array", async () => {
        const scopeToken = await tokenWithScopeString("patient/Patient.read patient/Observation.read", "token-1");
        const scpToken = await tokenWithScpArray(["patient/Patient.read", "patient/Observation.read"], "token-2");

        for (const jwt of [scopeToken, scpToken]) {
            expect((await get("/Patient/456", jwt)).status).toBe(200);
            expect((await get("/Observation/enc-1", jwt)).status).toBe(200);
            expect((await get("/Patient/123", jwt)).status).toBe(403);
        }
    });

    it("refuses a scp array entry that is not a SMART scope exactly as the scope string form refuses it", async () => {
        const scopeToken = await tokenWithScopeString("openid profile", "token-3");
        const scpToken = await tokenWithScpArray(["openid", "profile"], "token-4");

        const scopeResponse = await get("/Patient/456", scopeToken);
        const scpResponse = await get("/Patient/456", scpToken);

        expect(scopeResponse.status).toBe(401);
        expect(scpResponse.status).toBe(scopeResponse.status);
    });

    it("ignores a malformed entry alongside a valid one in both delivery forms", async () => {
        const scopeToken = await tokenWithScopeString("patient/Patient.read openid profile", "token-5");
        const scpToken = await tokenWithScpArray(["patient/Patient.read", "openid", "profile"], "token-6");

        for (const jwt of [scopeToken, scpToken]) {
            expect((await get("/Patient/456", jwt)).status).toBe(200);
            expect((await get("/Observation/enc-1", jwt)).status).toBe(403);
        }
    });

    it("governs by scp when both forms are present and scp is narrower", async () => {
        const jwt = await signPatientToken({ scope: "patient/*.*", scp: ["patient/Patient.read"] }, "token-7");

        expect((await get("/Patient/456", jwt)).status).toBe(200);
        expect((await get("/Observation/enc-1", jwt)).status).toBe(403);
    });

    it("refuses an unauthorized resource or verb in both delivery forms", async () => {
        const scopeToken = await tokenWithScopeString("patient/Patient.read", "token-8");
        const scpToken = await tokenWithScpArray(["patient/Patient.read"], "token-9");

        for (const jwt of [scopeToken, scpToken]) {
            expect((await get("/Observation/enc-1", jwt)).status).toBe(403);
            expect((await remove("/Observation/enc-1", jwt)).status).toBe(403);
        }
    });

    it("resolves v1 read into read and search permissions for both delivery forms", async () => {
        const scopeToken = await tokenWithScopeString("patient/Observation.read", "token-10");
        const scpToken = await tokenWithScpArray(["patient/Observation.read"], "token-11");

        for (const jwt of [scopeToken, scpToken]) {
            expect((await get(`/Observation?patient=Patient/${PATIENT_ID}`, jwt)).status).toBe(200);
            expect((await remove("/Observation/enc-1", jwt)).status).toBe(403);
        }
    });
});
