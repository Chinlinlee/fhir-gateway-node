import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { ConfigError, loadGatewayConfig, minimalValidEnv } from "../src/configs";
import type { GatewayConfig } from "../src/configs/env.schema";
import { ENV_KEYS } from "../src/constants/config";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";

const INTERNAL_CREDENTIAL_HEADER = "x-internal-credential";
const INTERNAL_CREDENTIAL = "ehr-service-credential";
const PATIENT_ID = "456";
const ENCOUNTER_ID = "enc-1";
const PATIENT_LIST_ID = "patient-list-1";
const REGISTER_PATH = "http://localhost/internal/launch-contexts";

function createConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
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
        internalLaunchApiEnabled: true,
        internalLaunchApiCredential: INTERNAL_CREDENTIAL,
        launchContextTtlSeconds: 300,
        ...overrides,
    };
}

function registerRequest(body: unknown, credential: string | null = INTERNAL_CREDENTIAL): Request {
    return new Request(REGISTER_PATH, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            ...(credential === null ? {} : { [INTERNAL_CREDENTIAL_HEADER]: credential }),
        },
        body: JSON.stringify(body),
    });
}

describe("internal launch context API", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("registers a launch context and returns an opaque launch id with its expiry", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID, encounterId: ENCOUNTER_ID }));
        const body = (await response.json()) as {
            launchId: string;
            expiresInSeconds: number;
            expiresAt: string;
        };

        expect(response.status).toBe(201);
        expect(typeof body.launchId).toBe("string");
        expect(body.launchId.length).toBeGreaterThan(0);
        expect(body.expiresInSeconds).toBe(300);
        expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("writes the registered launch context into the store injected at app construction", async () => {
        const store = new InMemoryLaunchContextStore();
        const app = createApp({ config: createConfig(), launchContextStore: store });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID, encounterId: ENCOUNTER_ID }));
        const body = (await response.json()) as { launchId: string };
        // 綁定發生在 authorization flow 的 callback（後續票），這裡確認 context 進了注入的 store。
        const bound = await store.bind(body.launchId, "user-1", "app-1");

        expect(bound?.patientId).toBe(PATIENT_ID);
        expect(bound?.encounterId).toBe(ENCOUNTER_ID);
    });

    it("accepts a launch context without an encounter", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID }));

        expect(response.status).toBe(201);
    });

    it("registers a launch context that authorizes a patient list instead of a single patient", async () => {
        const store = new InMemoryLaunchContextStore();
        const app = createApp({ config: createConfig(), launchContextStore: store });

        const response = await app.handle(registerRequest({ patientListId: PATIENT_LIST_ID }));
        const body = (await response.json()) as { launchId: string };
        const bound = await store.bind(body.launchId, "user-1", "app-1");

        expect(response.status).toBe(201);
        expect(bound?.patientListId).toBe(PATIENT_LIST_ID);
        expect(bound?.patientId).toBeUndefined();
    });

    it("rejects a registration that names both a patient and a patient list", async () => {
        const app = createApp({ config: createConfig() });

        expect(
            (await app.handle(registerRequest({ patientId: PATIENT_ID, patientListId: PATIENT_LIST_ID }))).status,
        ).toBe(400);
    });

    it("does not write the patient list into the application log", async () => {
        const logLines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            logLines.push(args.map(String).join(" "));
        });
        const app = createApp({ config: createConfig() });

        const created = await app.handle(registerRequest({ patientListId: PATIENT_LIST_ID }));

        expect(created.status).toBe(201);
        expect(logLines.join("\n")).not.toContain(PATIENT_LIST_ID);
    });

    it("issues a distinct launch id per registration", async () => {
        const app = createApp({ config: createConfig() });

        const first = (await (await app.handle(registerRequest({ patientId: PATIENT_ID }))).json()) as {
            launchId: string;
        };
        const second = (await (await app.handle(registerRequest({ patientId: PATIENT_ID }))).json()) as {
            launchId: string;
        };

        expect(first.launchId).not.toBe(second.launchId);
    });

    it("returns a launch id that does not reveal the patient or the encounter", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID, encounterId: ENCOUNTER_ID }));
        const raw = await response.text();

        expect(raw).not.toContain(PATIENT_ID);
        expect(raw).not.toContain(ENCOUNTER_ID);
        expect(raw).not.toContain(INTERNAL_CREDENTIAL);
    });

    it("rejects a registration without the internal credential", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID }, null));

        expect(response.status).toBe(401);
    });

    it("rejects a registration with a wrong internal credential", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID }, "not-the-credential"));

        expect(response.status).toBe(401);
    });

    it("does not accept a patient-facing bearer token as the internal credential", async () => {
        const app = createApp({ config: createConfig() });
        const request = new Request(REGISTER_PATH, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                Authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.patient-facing-token.signature",
            },
            body: JSON.stringify({ patientId: PATIENT_ID }),
        });

        const response = await app.handle(request);

        expect(response.status).toBe(401);
    });

    it("rejects a registration without a patient", async () => {
        const app = createApp({ config: createConfig() });

        expect((await app.handle(registerRequest({}))).status).toBe(400);
        expect((await app.handle(registerRequest({ patientId: "  " }))).status).toBe(400);
        expect((await app.handle(registerRequest({ patientId: 456 }))).status).toBe(400);
    });

    it("rejects a registration with a non-string encounter", async () => {
        const app = createApp({ config: createConfig() });

        const response = await app.handle(registerRequest({ patientId: PATIENT_ID, encounterId: 7 }));

        expect(response.status).toBe(400);
    });

    it("rejects a registration with an unparsable body", async () => {
        const app = createApp({ config: createConfig() });
        const request = new Request(REGISTER_PATH, {
            method: "POST",
            headers: { "content-type": "application/json", [INTERNAL_CREDENTIAL_HEADER]: INTERNAL_CREDENTIAL },
            body: "not-json",
        });

        expect((await app.handle(request)).status).toBe(400);
    });

    it("is not registered when the internal launch API is disabled", async () => {
        const app = createApp({ config: createConfig({ internalLaunchApiEnabled: false }) });

        expect((await app.handle(registerRequest({ patientId: PATIENT_ID }))).status).toBe(404);
    });

    it("does not write the patient or the encounter into the application log", async () => {
        const logLines: string[] = [];
        const capture = (...args: unknown[]) => {
            logLines.push(args.map(String).join(" "));
        };
        vi.spyOn(console, "log").mockImplementation(capture);
        vi.spyOn(console, "error").mockImplementation(capture);
        vi.spyOn(console, "warn").mockImplementation(capture);
        const app = createApp({ config: createConfig() });

        const created = await app.handle(registerRequest({ patientId: PATIENT_ID, encounterId: ENCOUNTER_ID }));
        const wrongCredential = await app.handle(registerRequest({ patientId: PATIENT_ID }, "wrong-credential"));
        const invalid = await app.handle(registerRequest({ encounterId: ENCOUNTER_ID }));

        expect([created.status, wrongCredential.status, invalid.status]).toEqual([201, 401, 400]);
        const logged = logLines.join("\n");
        expect(logged).not.toContain(PATIENT_ID);
        expect(logged).not.toContain(ENCOUNTER_ID);
        expect(logged).not.toContain(INTERNAL_CREDENTIAL);
        expect(logged).not.toContain("wrong-credential");
    });
});

describe("internal launch API startup configuration", () => {
    it("fails startup naming the credential variable when enabled without a credential", () => {
        const env = minimalValidEnv({ [ENV_KEYS.INTERNAL_LAUNCH_API_ENABLED]: "true" });

        expect(() => loadGatewayConfig(env)).toThrow(ConfigError);
        expect(() => loadGatewayConfig(env)).toThrow(ENV_KEYS.INTERNAL_LAUNCH_API_CREDENTIAL);
    });

    it("fails startup when the internal launch API is enabled with a blank credential", () => {
        const env = minimalValidEnv({
            [ENV_KEYS.INTERNAL_LAUNCH_API_ENABLED]: "true",
            [ENV_KEYS.INTERNAL_LAUNCH_API_CREDENTIAL]: "   ",
        });

        expect(() => loadGatewayConfig(env)).toThrow(ENV_KEYS.INTERNAL_LAUNCH_API_CREDENTIAL);
    });

    it("leaves the internal launch API disabled by default", () => {
        const config = loadGatewayConfig(minimalValidEnv());

        expect(config.internalLaunchApiEnabled).toBe(false);
        expect(config.internalLaunchApiCredential).toBeUndefined();
    });

    it("keeps a positive unbound launch context TTL by default", () => {
        expect(loadGatewayConfig(minimalValidEnv()).launchContextTtlSeconds).toBeGreaterThan(0);
    });

    it("rejects a non-positive launch context TTL", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ [ENV_KEYS.LAUNCH_CONTEXT_TTL_SECONDS]: "0" }))).toThrow(
            ENV_KEYS.LAUNCH_CONTEXT_TTL_SECONDS,
        );
    });
});
