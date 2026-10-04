/// <reference types="fhir" />

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";

import { fetch as undiciFetch } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX, SMART_API_PREFIX, SMART_AUTHORIZE_PATH, SMART_TOKEN_PATH } from "../src/constants/routes";
import { INTERNAL_CREDENTIAL_HEADER } from "../src/controllers/internal-launch/internal-launch.controller";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

const GATEWAY_BASE_URL = "https://gateway.example";
const APP_CLIENT_ID = "smart-app-client";
const APP_REDIRECT_URI = "https://app.example/callback";
const APP_STATE = "app-state-0S6_WzA2Mj";
const GATEWAY_IDP_CLIENT_ID = "gateway-idp-client";
const GATEWAY_IDP_CLIENT_SECRET = "gateway-idp-client-secret";
const INTERNAL_CREDENTIAL = "ehr-internal-credential";
const CLINICIAN_SUBJECT = "clinician-42";
const PATIENT_ID = "456";
const ENCOUNTER_ID = "enc-1";
const OTHER_PATIENT_ID = "999";
const CODE_VERIFIER = "sBQnbpC_DdE9KZ1TLJKqzKvHqGHvVv0nQrTvVWkGWU8a";
const CODE_CHALLENGE = createHash("sha256").update(CODE_VERIFIER).digest("base64url");

type AuditUpstreamServer = {
    baseUrl: string;
    /** 送到稽核後端的 AuditEvent，依送出順序。 */
    auditEvents: () => fhir4.AuditEvent[];
    close: () => Promise<void>;
};

/** 取第 n 則 AuditEvent；不足 n+1 則就讓斷言直接失敗，而不是讀到 undefined。 */
function auditEventAt(events: fhir4.AuditEvent[], index: number): fhir4.AuditEvent {
    expect(events.length).toBeGreaterThan(index);
    const event = events[index];
    if (event === undefined) {
        throw new Error(`no AuditEvent at index ${index}`);
    }
    return event;
}

/** AuditEvent 的 entity 參照；稽核軌跡裡「哪一位病人」就落在這裡。 */
function entityReferences(event: fhir4.AuditEvent): string[] {
    return (event.entity ?? []).flatMap((entity) =>
        entity.what?.reference !== undefined ? [entity.what.reference] : [],
    );
}

/** AuditEvent 記錄的參與者身分；「哪位醫師」就看這裡的 identifier。 */
function agentIdentifiers(event: fhir4.AuditEvent): fhir4.Identifier[] {
    return (event.agent ?? []).flatMap((agent) => (agent.who?.identifier !== undefined ? [agent.who.identifier] : []));
}

/** AuditEvent 記錄的參與者顯示名；「哪一個 client」就看這裡。 */
function agentDisplays(event: fhir4.AuditEvent): (string | undefined)[] {
    return (event.agent ?? []).map((agent) => agent.who?.display);
}

async function startAuditUpstreamServer(auditPostStatus = 201): Promise<AuditUpstreamServer> {
    const posted: fhir4.AuditEvent[] = [];
    const server: Server = createServer((req, res) => {
        const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;

        if (req.method === "GET" && path === `/fhir/Patient/${PATIENT_ID}`) {
            res.writeHead(200, { "content-type": "application/fhir+json" });
            res.end(JSON.stringify({ resourceType: "Patient", id: PATIENT_ID }));
            return;
        }

        if (req.method === "POST" && path === "/fhir/AuditEvent") {
            let body = "";
            req.on("data", (chunk: Buffer) => {
                body += chunk.toString("utf8");
            });
            req.on("end", () => {
                posted.push(JSON.parse(body) as fhir4.AuditEvent);
                res.writeHead(auditPostStatus, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "OperationOutcome" }));
            });
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
        throw new Error("Failed to start audit upstream server");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}/fhir`,
        auditEvents: () => posted,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

function createConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
    return {
        proxyTo: "http://127.0.0.1:0/fhir",
        tokenIssuer: "http://token-issuer",
        backendType: "HAPI",
        accessChecker: "basic",
        auditEventActions: ["R"],
        wellKnownEndpoint: "test",
        runMode: "PROD",
        allowTokenIssuerHostMismatch: false,
        port: 3000,
        gatewayPublicBaseUrl: GATEWAY_BASE_URL,
        gatewayClientId: GATEWAY_IDP_CLIENT_ID,
        gatewayClientSecret: GATEWAY_IDP_CLIENT_SECRET,
        internalLaunchApiEnabled: true,
        internalLaunchApiCredential: INTERNAL_CREDENTIAL,
        launchContextTtlSeconds: 600,
        ...overrides,
    };
}

function registerLaunchContextRequest(body: unknown): Request {
    return new Request("http://localhost/internal/launch-contexts", {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_CREDENTIAL_HEADER]: INTERNAL_CREDENTIAL },
        body: JSON.stringify(body),
    });
}

function gatewayAuthorize(launch: string): Request {
    const params = new URLSearchParams({
        response_type: "code",
        client_id: APP_CLIENT_ID,
        redirect_uri: APP_REDIRECT_URI,
        scope: "launch/patient patient/Patient.read openid fhirUser",
        aud: "https://fhir.example",
        launch,
        nonce: "n-0S6_WzA2Mj",
        state: APP_STATE,
        code_challenge: CODE_CHALLENGE,
        code_challenge_method: "S256",
    });
    return new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_AUTHORIZE_PATH}?${params.toString()}`, {
        redirect: "manual",
    });
}

async function locationOf(response: Response): Promise<URL> {
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    return new URL(location ?? "");
}

describe("Launch AuditEvent at the launch lifecycle points", () => {
    let issuer: IssuerTestServer;
    let upstream: AuditUpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let store: InMemoryLaunchContextStore;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test", {
            serveAuthorizationFlow: true,
            clientId: GATEWAY_IDP_CLIENT_ID,
            clientSecret: GATEWAY_IDP_CLIENT_SECRET,
            subject: CLINICIAN_SUBJECT,
        });
        upstream = await startAuditUpstreamServer();
        tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: issuer.issuerUrl,
            wellKnownEndpoint: issuer.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
        store = new InMemoryLaunchContextStore();
    });

    afterEach(async () => {
        await issuer.close();
        await upstream.close();
    });

    const buildApp = (overrides: Partial<GatewayConfig> = {}) => {
        const config = createConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: upstream.baseUrl,
            allowedQueriesFile: allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
            ...overrides,
        });
        return createApp({
            tokenVerifier,
            config,
            allowedQueries: AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
            patientFinder: PatientFinderService.getInstance(),
            launchContextStore: store,
        });
    };

    /** EHR 在 App 開啟前註冊 launch context，拿到 gateway 生成的 launch id。 */
    const register = async (app: App): Promise<string> => {
        const response = await app.handle(registerLaunchContextRequest({ patientId: PATIENT_ID }));
        expect(response.status).toBe(201);
        return ((await response.json()) as { launchId: string }).launchId;
    };

    /** 跑完整條瀏覽器路徑：authorize → IdP → gateway callback → App 的 redirect_uri。 */
    const runLaunch = async (app: App, launch: string): Promise<string> => {
        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(launch)));
        const idpResponse = await undiciFetch(idpRedirect, { redirect: "manual" });
        const gatewayCallback = await locationOf(idpResponse);
        const appRedirect = await locationOf(await app.handle(new Request(gatewayCallback, { redirect: "manual" })));
        return appRedirect.searchParams.get("code") ?? "";
    };

    /** App 拿 gateway 發的一次性 code 換 access token。 */
    const exchangeCode = async (app: App, code: string): Promise<string> => {
        const response = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${SMART_API_PREFIX}${SMART_TOKEN_PATH}`, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: APP_REDIRECT_URI,
                    client_id: APP_CLIENT_ID,
                    code_verifier: CODE_VERIFIER,
                }).toString(),
            }),
        );
        expect(response.status).toBe(200);
        return ((await response.json()) as { access_token: string }).access_token;
    };

    /** App 用那張 access token 讀某位病人的資源，回 gateway 給的 status。 */
    const readPatientWith = async (app: App, accessToken: string, patientId: string): Promise<number> => {
        const response = await app.handle(
            new Request(`${GATEWAY_BASE_URL}${FHIR_API_PREFIX}/Patient/${patientId}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
        );
        return response.status;
    };

    it("records the launch context the EHR registered and the patient it is bound to", async () => {
        const app = buildApp();

        const response = await app.handle(registerLaunchContextRequest({ patientId: PATIENT_ID }));

        expect(response.status).toBe(201);
        expect(upstream.auditEvents()).toHaveLength(1);
        expect(entityReferences(auditEventAt(upstream.auditEvents(), 0))).toEqual([`Patient/${PATIENT_ID}`]);
    });

    it("records the bound patient but not the rest of what the EHR sent", async () => {
        const app = buildApp();

        const response = await app.handle(
            registerLaunchContextRequest({ patientId: PATIENT_ID, encounterId: ENCOUNTER_ID }),
        );

        expect(response.status).toBe(201);
        const registration = auditEventAt(upstream.auditEvents(), 0);
        expect(entityReferences(registration)).toEqual([`Patient/${PATIENT_ID}`]);
        expect(JSON.stringify(registration)).not.toContain(ENCOUNTER_ID);
    });

    it("records the authorized user, the authorized client and the patient when the launch is bound", async () => {
        const app = buildApp();
        const launch = await register(app);

        const code = await runLaunch(app, launch);

        expect(code).not.toBe("");
        expect(upstream.auditEvents()).toHaveLength(2);
        const binding = auditEventAt(upstream.auditEvents(), 1);
        expect(entityReferences(binding)).toEqual([`Patient/${PATIENT_ID}`]);
        expect(agentIdentifiers(binding)).toContainEqual({ system: issuer.issuerUrl, value: CLINICIAN_SUBJECT });
        expect(agentDisplays(binding)).toContain(APP_CLIENT_ID);
        // 綁定發生在 context 建立之後，兩則事件的時間順序就是「先註冊、後授權」。
        expect(new Date(auditEventAt(upstream.auditEvents(), 1).recorded).getTime()).toBeGreaterThanOrEqual(
            new Date(auditEventAt(upstream.auditEvents(), 0).recorded).getTime(),
        );
    });

    it("keeps launch lifecycle events in their own category apart from the access events of the same launch", async () => {
        const app = buildApp();
        const launch = await register(app);
        const accessToken = await exchangeCode(app, await runLaunch(app, launch));

        expect(await readPatientWith(app, accessToken, PATIENT_ID)).toBe(200);

        // 兩則 launch lifecycle 事件同類，且與這次 launch 產生的 access 事件不同類：
        // 稽核消費者不必看內容就能分流。
        expect(upstream.auditEvents()).toHaveLength(3);
        const created = auditEventAt(upstream.auditEvents(), 0);
        const bound = auditEventAt(upstream.auditEvents(), 1);
        const accessed = auditEventAt(upstream.auditEvents(), 2);
        expect(created.type?.system).toBe(bound.type?.system);
        expect(accessed.type?.system).not.toBe(created.type?.system);
    });

    it("still registers, binds and authorizes FHIR when the audit backend rejects every AuditEvent", async () => {
        const broken = await startAuditUpstreamServer(500);
        try {
            const app = buildApp({ proxyTo: broken.baseUrl, accessChecker: "patient" });
            const launch = await register(app);

            const accessToken = await exchangeCode(app, await runLaunch(app, launch));

            // 稽核後端每則都收得到，但註冊、綁定與 FHIR 授權裁決都不受影響。
            expect(broken.auditEvents()).toHaveLength(2);
            expect(await readPatientWith(app, accessToken, PATIENT_ID)).toBe(200);
            expect(await readPatientWith(app, accessToken, OTHER_PATIENT_ID)).toBe(403);
        } finally {
            await broken.close();
        }
    });
});
