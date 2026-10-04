/// <reference types="fhir" />

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type App, createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { INTERNAL_CREDENTIAL_HEADER } from "../src/controllers/internal-launch/internal-launch.controller";
import { AllowedQueriesCheckerService } from "../src/services/allowed-queries.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { allowedQueriesFixturePath } from "./helpers/allowed-queries-fixture";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";
import {
    APP_CLIENT_ID,
    APP_REDIRECT_URI,
    AUTHORIZED_PATIENT,
    authenticateAtIdp,
    authorizeParams,
    CLINICIAN_SUBJECT,
    CODE_VERIFIER,
    createBaseConfig,
    GATEWAY_BASE_URL,
    GATEWAY_IDP_CLIENT_ID,
    GATEWAY_IDP_CLIENT_SECRET,
    gatewayAuthorize,
    gatewayToken,
    INTERNAL_CREDENTIAL,
    locationOf,
    OTHER_PATIENT,
    registerLaunchContext,
    startUpstreamServer,
    type UpstreamServer,
} from "./helpers/launch-flow-fixture";

const ENCOUNTER_ID = "enc-1";

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

/** AuditEvent 記錄的 launch id；註冊與綁定兩則事件靠它配對。 */
function launchContextIds(event: fhir4.AuditEvent): string[] {
    return (event.entity ?? []).flatMap((entity) => (entity.name !== undefined ? [entity.name] : []));
}

/** AuditEvent 記錄的參與者身分；「哪位醫師」就看這裡的 identifier。 */
function agentIdentifiers(event: fhir4.AuditEvent): fhir4.Identifier[] {
    return (event.agent ?? []).flatMap((agent) => (agent.who?.identifier !== undefined ? [agent.who.identifier] : []));
}

/** AuditEvent 記錄的參與者顯示名；「哪一個 client」就看這裡。 */
function agentDisplays(event: fhir4.AuditEvent): (string | undefined)[] {
    return (event.agent ?? []).map((agent) => agent.who?.display);
}

describe("Launch AuditEvent at the launch lifecycle points", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;
    let tokenVerifier: TokenVerifierService;
    let store: InMemoryLaunchContextStore;

    const buildApp = (overrides: Partial<GatewayConfig> = {}, auditUpstream: UpstreamServer = upstream) => {
        const config = createBaseConfig({
            tokenIssuer: issuer.issuerUrl,
            proxyTo: auditUpstream.baseUrl,
            allowedQueriesFile: allowedQueriesFixturePath("allowed_unauthenticated_queries.json"),
            auditEventActions: ["R"],
            accessChecker: "basic",
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

    /** 跑完整條瀏覽器路徑：authorize → IdP → gateway callback → App 的 redirect_uri。 */
    const runLaunch = async (app: App, launchId: string): Promise<string> => {
        const idpRedirect = await locationOf(await app.handle(gatewayAuthorize(authorizeParams(launchId))));
        const gatewayCallback = await authenticateAtIdp(idpRedirect);
        const appRedirect = await locationOf(await app.handle(new Request(gatewayCallback, { redirect: "manual" })));
        return appRedirect.searchParams.get("code") ?? "";
    };

    /** App 拿 gateway 發的一次性 code 換 access token。 */
    const exchangeCode = async (app: App, code: string): Promise<string> => {
        const response = await app.handle(
            gatewayToken({
                grant_type: "authorization_code",
                code,
                redirect_uri: APP_REDIRECT_URI,
                client_id: APP_CLIENT_ID,
                code_verifier: CODE_VERIFIER,
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

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test", {
            serveAuthorizationFlow: true,
            clientId: GATEWAY_IDP_CLIENT_ID,
            clientSecret: GATEWAY_IDP_CLIENT_SECRET,
            subject: CLINICIAN_SUBJECT,
        });
        upstream = await startUpstreamServer();
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

    it("records the launch context the EHR registered and the patient it is bound to", async () => {
        const app = buildApp();

        const response = await app.handle(registerRequest({ patientId: AUTHORIZED_PATIENT }));

        expect(response.status).toBe(201);
        expect(upstream.auditEvents()).toHaveLength(1);
        expect(entityReferences(auditEventAt(upstream.auditEvents(), 0))).toEqual([`Patient/${AUTHORIZED_PATIENT}`]);
    });

    it("records the bound patient but not the rest of what the EHR sent", async () => {
        const app = buildApp();

        const response = await app.handle(
            registerRequest({ patientId: AUTHORIZED_PATIENT, encounterId: ENCOUNTER_ID }),
        );

        expect(response.status).toBe(201);
        const registration = auditEventAt(upstream.auditEvents(), 0);
        expect(entityReferences(registration)).toEqual([`Patient/${AUTHORIZED_PATIENT}`]);
        expect(JSON.stringify(registration)).not.toContain(ENCOUNTER_ID);
    });

    it("records the authorized user, the authorized client and the patient when the launch is bound", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });

        const code = await runLaunch(app, launchId);

        expect(code).not.toBe("");
        expect(upstream.auditEvents()).toHaveLength(2);
        const binding = auditEventAt(upstream.auditEvents(), 1);
        expect(entityReferences(binding)).toEqual([`Patient/${AUTHORIZED_PATIENT}`]);
        expect(agentIdentifiers(binding)).toContainEqual({ system: issuer.issuerUrl, value: CLINICIAN_SUBJECT });
        expect(agentDisplays(binding)).toContain(APP_CLIENT_ID);
        // 綁定發生在 context 建立之後，兩則事件的時間順序就是「先註冊、後授權」。
        expect(new Date(binding.recorded).getTime()).toBeGreaterThanOrEqual(
            new Date(auditEventAt(upstream.auditEvents(), 0).recorded).getTime(),
        );
    });

    it("pairs the binding back to the registration that authorized it", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });

        await runLaunch(app, launchId);

        const [registration, binding] = [
            auditEventAt(upstream.auditEvents(), 0),
            auditEventAt(upstream.auditEvents(), 1),
        ];

        // 兩則事件帶著同一個 launch id：這就是「誰授權了這位醫師看哪位病人」的配對依據，
        // access token 本身不含 PHI，因此這是唯一能把兩者連起來的東西。
        expect(launchContextIds(registration)).toEqual([launchId]);
        expect(launchContextIds(binding)).toEqual([launchId]);
    });

    it("keeps launch lifecycle events in their own category apart from the access events of the same launch", async () => {
        const app = buildApp();
        const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });
        const accessToken = await exchangeCode(app, await runLaunch(app, launchId));

        expect(await readPatientWith(app, accessToken, AUTHORIZED_PATIENT)).toBe(200);

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
        const broken = await startUpstreamServer({ auditPostStatus: 500 });
        try {
            const app = buildApp({ accessChecker: "patient" }, broken);
            const launchId = await registerLaunchContext(app, { patientId: AUTHORIZED_PATIENT });

            const accessToken = await exchangeCode(app, await runLaunch(app, launchId));

            // 稽核後端每則都收得到，但註冊、綁定與 FHIR 授權裁決都不受影響。
            expect(broken.auditEvents()).toHaveLength(2);
            expect(await readPatientWith(app, accessToken, AUTHORIZED_PATIENT)).toBe(200);
            expect(await readPatientWith(app, accessToken, OTHER_PATIENT)).toBe(403);
        } finally {
            await broken.close();
        }
    });
});

/** EHR 註冊 launch context 的內部請求；它不經 app 的 helper，因此保留在本檔案。 */
function registerRequest(body: Record<string, string>): Request {
    return new Request("http://localhost/internal/launch-contexts", {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_CREDENTIAL_HEADER]: INTERNAL_CREDENTIAL },
        body: JSON.stringify(body),
    });
}
