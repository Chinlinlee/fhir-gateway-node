import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import type { Client } from "fhir-kit-client";

import { createFhirKitClient } from "../src/utils/fhir-kit-client.util.js";

type ResourceSearchPair = {
    resourceType: string;
    searchParam: string;
};

type E2eConfig = {
    proxyBaseUrl: string;
    serverBaseUrl: string;
    tokenUrl: string;
    clientId: string;
    username: string;
    password: string;
    maxPollAttempts: number;
    pollIntervalMs: number;
};

type FhirResource = {
    resourceType: string;
    id?: string;
    [key: string]: unknown;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_TEST_PATH = path.resolve(__dirname, "../.env.test");

loadDotenv({ path: ENV_TEST_PATH });

const PRELOAD_FILES = [
    "Organization-org-hosp-example.json",
    "Location-loc-ent-example.json",
    "Practitioner-pra-dr-example.json",
    "Patient-pat-example.json",
    "Encounter-enc-example.json",
] as const;

const OBSERVATION_FILE = "Observation-obs-heart-rate-example.json";
const PATIENT_REFERENCE = "Patient/pat-example";

function logEvent(action: string, detail?: string): void {
    if (detail) {
        console.log(`${action} | ${detail}`);
        return;
    }
    console.log(`${action}`);
}

function logStage(title: string): void {
    console.log(`\n=== ${title} ===`);
}

function getConfig(): E2eConfig {
    logEvent("CONFIG_LOAD_START", `.env.test=${ENV_TEST_PATH}`);
    const config: E2eConfig = {
        proxyBaseUrl: process.env.E2E_PROXY_BASE_URL ?? "http://localhost:3000/fhir",
        serverBaseUrl: process.env.E2E_SERVER_BASE_URL ?? "http://localhost:8099/fhir",
        tokenUrl: process.env.E2E_TOKEN_URL ?? "http://localhost:8080/realms/smart/protocol/openid-connect/token",
        clientId: process.env.E2E_CLIENT_ID ?? "demo-smart-app",
        username: process.env.E2E_USERNAME ?? "testuser",
        password: process.env.E2E_PASSWORD ?? "testpass",
        maxPollAttempts: Number(process.env.E2E_MAX_POLL_ATTEMPTS ?? "15"),
        pollIntervalMs: Number(process.env.E2E_POLL_INTERVAL_MS ?? "1000"),
    };
    logEvent("CONFIG_LOAD_DONE", `proxy=${config.proxyBaseUrl}, server=${config.serverBaseUrl}`);
    logEvent("CONFIG_RUNTIME", `pollAttempts=${config.maxPollAttempts}, pollIntervalMs=${config.pollIntervalMs}`);
    return config;
}

function assertIsRecord(value: unknown): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object") {
        throw new Error("Expected object response from FHIR endpoint");
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function reportE2eFailure(error: unknown): void {
    logEvent("RUN_FAIL");
    if (error instanceof Error) {
        if (error.stack) {
            console.error(error.stack);
        } else {
            console.error(error.message);
        }
        return;
    }
    console.error(String(error));
}

async function readResourceFixture(fileName: string): Promise<FhirResource> {
    const filePath = path.join(__dirname, fileName);
    logEvent("FIXTURE_READ_START", fileName);
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    assertIsRecord(parsed);
    const resourceType = parsed.resourceType;
    if (typeof resourceType !== "string" || resourceType.length === 0) {
        throw new Error(`Fixture ${fileName} missing resourceType`);
    }
    logEvent("FIXTURE_READ_DONE", `${fileName} -> ${resourceType}`);
    return parsed as FhirResource;
}

async function getAuthToken(config: E2eConfig): Promise<string> {
    logEvent("TOKEN_REQUEST_START", `url=${config.tokenUrl}, clientId=${config.clientId}, user=${config.username}`);
    const formData = new URLSearchParams({
        client_id: config.clientId,
        username: config.username,
        password: config.password,
        grant_type: "password",
    });

    const response = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: formData.toString(),
    });

    const responseText = await response.text();
    logEvent("TOKEN_REQUEST_RESPONSE", `status=${response.status}`);
    if (!response.ok) {
        throw new Error(
            `Failed to get auth token: ${response.status} ${response.statusText}${responseText.length > 0 ? ` — ${responseText}` : ""}`,
        );
    }

    let payload: unknown;
    try {
        payload = JSON.parse(responseText) as unknown;
    } catch {
        throw new Error("Token endpoint returned non-JSON body");
    }
    assertIsRecord(payload);
    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new Error("Token endpoint response missing access_token");
    }
    logEvent("TOKEN_REQUEST_DONE", `tokenLength=${accessToken.length}, token=${accessToken}`);
    return accessToken;
}

function createFhirClient(baseUrl: string, token?: string): Client {
    logEvent("CLIENT_CREATE", `${baseUrl}${token ? " (auth)" : " (no-auth)"}`);
    return createFhirKitClient({
        baseUrl,
        ...(token ? { bearerToken: token } : {}),
    });
}

async function queryResourceCount(
    client: Client,
    resourceType: string,
    searchParam: string,
    patientReference: string,
): Promise<number> {
    const encodedPatient = encodeURIComponent(patientReference);
    const query = `${resourceType}?${searchParam}=${encodedPatient}&_summary=count`;
    logEvent("COUNT_QUERY_START", query);
    const bundle = (await client.request(query)) as unknown;
    assertIsRecord(bundle);
    const total = bundle.total;
    if (typeof total !== "number") {
        throw new Error(`Count query for ${resourceType} missing numeric total`);
    }
    logEvent("COUNT_QUERY_DONE", `${resourceType} total=${total}`);
    return total;
}

async function preloadResource(client: Client, fileName: string): Promise<void> {
    logEvent("PRELOAD_RESOURCE_START", fileName);
    const resource = await readResourceFixture(fileName);
    if (!resource.id) {
        throw new Error(`Fixture ${fileName} missing id for deterministic preload`);
    }
    await client.update({
        resourceType: resource.resourceType,
        id: resource.id,
        body: resource as never,
    });
    logEvent("PRELOAD_RESOURCE_DONE", `${resource.resourceType}/${resource.id}`);
}

async function preloadResources(serverClient: Client): Promise<void> {
    logEvent("PRELOAD_BATCH_START", `count=${PRELOAD_FILES.length}`);
    for (const fileName of PRELOAD_FILES) {
        await preloadResource(serverClient, fileName);
    }
    logEvent("PRELOAD_BATCH_DONE");
}

function createPostResource(resource: FhirResource): FhirResource {
    logEvent("POST_PAYLOAD_BUILD_START", resource.resourceType);
    const copied = JSON.parse(JSON.stringify(resource)) as FhirResource;
    if (copied.id) {
        copied.id = `${copied.id}-${Date.now()}`;
        logEvent("POST_PAYLOAD_ID_REWRITE", copied.id);
    }
    logEvent("POST_PAYLOAD_BUILD_DONE", copied.resourceType);
    return copied;
}

// Original function reference: test_proxy_and_server_equal_count
async function testProxyAndServerEqualCount(
    patientReferences: readonly string[],
    resourceSearchPairs: readonly ResourceSearchPair[],
    serverClient: Client,
    proxyClient: Client,
): Promise<void> {
    logStage("TEST proxy=server count");
    logEvent("TEST_START", "testProxyAndServerEqualCount");
    for (const patientReference of patientReferences) {
        logEvent("TEST_PATIENT", patientReference);
        for (const pair of resourceSearchPairs) {
            logEvent("TEST_PAIR_START", `${pair.resourceType} by ${pair.searchParam}`);
            const serverCount = await queryResourceCount(
                serverClient,
                pair.resourceType,
                pair.searchParam,
                patientReference,
            );
            const proxyCount = await queryResourceCount(
                proxyClient,
                pair.resourceType,
                pair.searchParam,
                patientReference,
            );

            if (serverCount !== proxyCount) {
                throw new Error(
                    `Count mismatch for ${pair.resourceType} ${patientReference}: server=${serverCount}, proxy=${proxyCount}`,
                );
            }
            logEvent("TEST_PAIR_PASS", `${pair.resourceType} server=${serverCount} proxy=${proxyCount}`);
        }
    }
    logEvent("TEST_DONE", "testProxyAndServerEqualCount");
}

// Original function reference: test_post_resource_increase_count
async function testPostResourceIncreaseCount(
    resourceSearchPair: ResourceSearchPair,
    fileName: string,
    patientReference: string,
    config: E2eConfig,
    serverClient: Client,
    proxyClient: Client,
): Promise<void> {
    logStage("TEST post increases count");
    logEvent("TEST_START", "testPostResourceIncreaseCount");
    const beforeServerCount = await queryResourceCount(
        serverClient,
        resourceSearchPair.resourceType,
        resourceSearchPair.searchParam,
        patientReference,
    );
    const beforeProxyCount = await queryResourceCount(
        proxyClient,
        resourceSearchPair.resourceType,
        resourceSearchPair.searchParam,
        patientReference,
    );

    if (beforeServerCount !== beforeProxyCount) {
        throw new Error(
            `Before POST mismatch for ${resourceSearchPair.resourceType}: server=${beforeServerCount}, proxy=${beforeProxyCount}`,
        );
    }
    logEvent("BASELINE_PASS", `server=${beforeServerCount} proxy=${beforeProxyCount}`);

    const fixture = await readResourceFixture(fileName);
    const createPayload = createPostResource(fixture);
    logEvent("POST_SEND_START", resourceSearchPair.resourceType);
    const createdResponse = (await proxyClient.create({
        resourceType: resourceSearchPair.resourceType,
        body: createPayload as never,
    })) as FhirResource;

    const createdId = createdResponse.id;
    if (!createdId) {
        throw new Error(`POST ${resourceSearchPair.resourceType} response missing id`);
    }
    logEvent("POST_SEND_DONE", `${resourceSearchPair.resourceType}/${createdId}`);

    logEvent("POST_READ_VERIFY_START", `${resourceSearchPair.resourceType}/${createdId}`);
    await serverClient.read({
        resourceType: resourceSearchPair.resourceType,
        id: createdId,
    });
    logEvent("POST_READ_VERIFY_DONE", `${resourceSearchPair.resourceType}/${createdId}`);

    const targetCount = beforeProxyCount + 1;
    logEvent("POLL_START", `target=${targetCount}`);
    for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
        logEvent("POLL_ATTEMPT", `${attempt}/${config.maxPollAttempts}`);
        const nextServerCount = await queryResourceCount(
            serverClient,
            resourceSearchPair.resourceType,
            resourceSearchPair.searchParam,
            patientReference,
        );
        const nextProxyCount = await queryResourceCount(
            proxyClient,
            resourceSearchPair.resourceType,
            resourceSearchPair.searchParam,
            patientReference,
        );

        logEvent("POLL_COUNTS", `server=${nextServerCount} proxy=${nextProxyCount}`);

        if (nextServerCount === targetCount && nextProxyCount === targetCount) {
            logEvent("POLL_DONE", `targetReached=${targetCount}`);
            logEvent("TEST_DONE", "testPostResourceIncreaseCount");
            return;
        }

        if (attempt < config.maxPollAttempts) {
            logEvent("POLL_SLEEP", `${config.pollIntervalMs}ms`);
            await sleep(config.pollIntervalMs);
        }
    }

    throw new Error(
        `POST created ${resourceSearchPair.resourceType}/${createdId} but search count did not reach ${targetCount} within polling window`,
    );
}

async function run(): Promise<void> {
    logStage("RUN Phase9 e2e");
    logEvent("RUN_START");
    const config = getConfig();
    const token = await getAuthToken(config);

    logStage("CLIENTS");
    const serverClient = createFhirClient(config.serverBaseUrl);
    const proxyClient = createFhirClient(config.proxyBaseUrl, token);

    logStage("PRELOAD");
    await preloadResources(serverClient);

    const resourceSearchPairs: readonly ResourceSearchPair[] = [
        { resourceType: "Encounter", searchParam: "patient" },
        { resourceType: "Observation", searchParam: "subject" },
    ];
    logEvent("TEST_MATRIX", resourceSearchPairs.map((pair) => `${pair.resourceType}:${pair.searchParam}`).join(", "));

    await testProxyAndServerEqualCount([PATIENT_REFERENCE], resourceSearchPairs, serverClient, proxyClient);

    await testPostResourceIncreaseCount(
        { resourceType: "Observation", searchParam: "subject" },
        OBSERVATION_FILE,
        PATIENT_REFERENCE,
        config,
        serverClient,
        proxyClient,
    );
    logEvent("RUN_DONE");
}

run().catch((error: unknown) => {
    reportE2eFailure(error);
    process.exitCode = 1;
});
