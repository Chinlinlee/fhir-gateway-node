import { createServer, type Server } from "node:http";

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { loadGatewayConfig, minimalValidEnv } from "../src/configs";
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

async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
            return;
        }

        res.writeHead(404, { "content-type": "application/fhir+json" });
        res.end(JSON.stringify({ resourceType: "OperationOutcome", issue: [{ code: "not-found" }] }));
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
        close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
    };
}

type PatientReadResponse = { id?: string };
type OperationOutcomeBody = { issue?: Array<{ code?: string; diagnostics?: string }> };

type AudienceScopedApp = {
    /** 以指定的 aud（undefined 表示 token 不帶 aud claim）發一次 patient compartment 的 FHIR 請求 */
    requestPatient(audience: string | string[] | undefined): Promise<Response>;
    /** 以指定 aud 與 scope 對 Patient 發 POST，觀察 scope 是否仍獨立裁決 */
    createPatient(audience: string, scope: string): Promise<Response>;
};

/**
 * 以真實環境變數載入設定（因此 TOKEN_AUDIENCE 的解析也在覆蓋範圍內），再走真實 app pipeline。
 */
async function createAudienceScopedApp(
    issuer: IssuerTestServer,
    upstream: UpstreamServer,
    tokenAudience: string | undefined,
): Promise<AudienceScopedApp> {
    const config = loadGatewayConfig(
        minimalValidEnv({
            PROXY_TO: upstream.baseUrl,
            TOKEN_ISSUER: issuer.issuerUrl,
            WELL_KNOWN_ENDPOINT: issuer.wellKnownPath,
            ...(tokenAudience === undefined ? {} : { TOKEN_AUDIENCE: tokenAudience }),
        }),
    );
    const tokenVerifier = await TokenVerifierService.create(config);
    const launchContextStore = new InMemoryLaunchContextStore();
    const app = createApp({
        tokenVerifier,
        config,
        patientFinder: PatientFinderService.getInstance(),
        launchContextStore,
    });

    // patient compartment 的 launch context 由 gateway 自己的 store 提供，不在 token 裡；
    // 每張新簽的 token 都帶一個獨一無二的 jti，並在送出前綁好同一組 launch context。
    let tokenCounter = 0;
    const signToken = async (audience: string | string[] | undefined, scope: string): Promise<string> => {
        tokenCounter += 1;
        const tokenId = `audience-test-token-${tokenCounter}`;
        await seedLaunchContextForToken(
            launchContextStore,
            { subject: "gateway-user", clientId: "test-app", tokenId },
            { patientId: "456" },
        );
        const builder = new SignJWT({ scope })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(issuer.issuerUrl)
            .setSubject("gateway-user")
            .setJti(tokenId);
        if (audience !== undefined) {
            builder.setAudience(audience);
        }
        return await builder.sign(issuer.keys.privateKey);
    };

    return {
        requestPatient: async (audience) =>
            await app.handle(
                new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                    headers: { Authorization: `Bearer ${await signToken(audience, "patient/Patient.read")}` },
                }),
            ),
        createPatient: async (audience, scope) =>
            await app.handle(
                new Request(`http://localhost${FHIR_API_PREFIX}/Patient`, {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${await signToken(audience, scope)}`,
                        "content-type": "application/fhir+json",
                    },
                    body: JSON.stringify({ resourceType: "Patient" }),
                }),
            ),
    };
}

const GATEWAY_AUDIENCE = "https://gateway.example/fhir";
const OTHER_HOSPITAL_AUDIENCE = "https://other-hospital.example/fhir";

describe("Access token audience validation over the app", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    it("authorises a token whose aud contains the configured audience as a bare string", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient(GATEWAY_AUDIENCE);

        expect(response.status).toBe(200);
        const body = (await response.json()) as PatientReadResponse;
        expect(body.id).toBe("456");
    });

    it("authorises a token whose aud array contains the configured audience among others", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient([OTHER_HOSPITAL_AUDIENCE, GATEWAY_AUDIENCE]);

        expect(response.status).toBe(200);
    });

    it("authorises a token whose aud is a single-element array", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient([GATEWAY_AUDIENCE]);

        expect(response.status).toBe(200);
    });

    it("authorises a token matching any of several configured audiences", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, `${OTHER_HOSPITAL_AUDIENCE}, ${GATEWAY_AUDIENCE}`);

        const matchingFirst = await app.requestPatient(OTHER_HOSPITAL_AUDIENCE);
        const matchingSecond = await app.requestPatient(GATEWAY_AUDIENCE);

        expect(matchingFirst.status).toBe(200);
        expect(matchingSecond.status).toBe(200);
    });

    it("refuses a correctly signed token whose aud names another resource server", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient(OTHER_HOSPITAL_AUDIENCE);

        expect(response.status).toBe(401);
    });

    it("refuses a token with no aud claim when an audience is configured", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient(undefined);

        expect(response.status).toBe(401);
    });

    it("does not name the accepted audience values in the rejection", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.requestPatient(OTHER_HOSPITAL_AUDIENCE);

        expect(response.status).toBe(401);
        const body = (await response.json()) as OperationOutcomeBody;
        expect(body.issue?.[0]?.diagnostics).not.toContain(GATEWAY_AUDIENCE);
    });

    it("keeps accepting tokens without aud when no audience is configured", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, undefined);

        const response = await app.requestPatient(undefined);

        expect(response.status).toBe(200);
    });

    it("keeps accepting tokens without aud when TOKEN_AUDIENCE is empty", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, "");

        const response = await app.requestPatient(undefined);

        expect(response.status).toBe(200);
    });

    it("keeps accepting tokens whose aud names another resource server when no audience is configured", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, undefined);

        const response = await app.requestPatient(OTHER_HOSPITAL_AUDIENCE);

        expect(response.status).toBe(200);
    });

    it("keeps accepting tokens without aud when the configured audience list is empty", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, "  ,  ");

        const response = await app.requestPatient(undefined);

        expect(response.status).toBe(200);
    });

    it("does not narrow scopes when the audience matches", async () => {
        const app = await createAudienceScopedApp(issuer, upstream, GATEWAY_AUDIENCE);

        const response = await app.createPatient(GATEWAY_AUDIENCE, "patient/Observation.read");

        expect(response.status).toBe(403);
    });
});
