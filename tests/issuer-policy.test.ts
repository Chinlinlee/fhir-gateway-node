import { createServer, type Server } from "node:http";

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { DEFAULT_CLAIM_NAMES } from "../src/constants/claim-names";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import * as issuerPolicyModule from "../src/services/issuer-policy/issuer-policy";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

type UpstreamServer = {
    baseUrl: string;
    close: () => Promise<void>;
};

async function startUpstreamServer(): Promise<UpstreamServer> {
    const server: Server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/fhir/Patient/456") {
            res.writeHead(200, { "content-type": "application/fhir+json", etag: "W/1" });
            res.end(JSON.stringify({ resourceType: "Patient", id: "456" }));
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

type IssuerScopedApp = {
    /** 以指定的 token issuer 發一次受保護的 FHIR 請求 */
    requestPatient(tokenIssuer: string): Promise<Response>;
};

/**
 * 建立走真實 app pipeline 的 issuer 範圍應用。
 * 回傳的 requestPatient 於建立後才送出請求，因此測試可在送出前才安裝 console.warn spy，
 * 避免把啟動期的 signing key resolver 警告算進去。
 */
async function createIssuerScopedApp(
    issuer: IssuerTestServer,
    upstream: UpstreamServer,
    runMode: GatewayConfig["runMode"],
    allowTokenIssuerHostMismatch: boolean,
): Promise<IssuerScopedApp> {
    const config: GatewayConfig = {
        proxyTo: upstream.baseUrl,
        tokenIssuer: issuer.issuerUrl,
        backendType: "HAPI",
        accessChecker: "patient",
        auditEventActions: [],
        wellKnownEndpoint: issuer.wellKnownPath,
        runMode,
        allowTokenIssuerHostMismatch,
        port: 3000,
    };
    const tokenVerifier = await TokenVerifierService.create({
        tokenIssuer: issuer.issuerUrl,
        wellKnownEndpoint: issuer.wellKnownPath,
        runMode,
        allowTokenIssuerHostMismatch,
    });
    const app = createApp({
        tokenVerifier,
        config,
        patientFinder: PatientFinderService.getInstance(),
    });

    return {
        requestPatient: async (tokenIssuer: string): Promise<Response> => {
            const jwt = await new SignJWT({
                [DEFAULT_CLAIM_NAMES.patient]: "456",
                scope: "patient/Patient.read",
            })
                .setProtectedHeader({ alg: "RS256" })
                .setIssuer(tokenIssuer)
                .sign(issuer.keys.privateKey);

            return await app.handle(
                new Request(`http://localhost${FHIR_API_PREFIX}/Patient/456`, {
                    headers: { Authorization: `Bearer ${jwt}` },
                }),
            );
        },
    };
}

describe("Issuer policy over the app", () => {
    let issuer: IssuerTestServer;
    let upstream: UpstreamServer;

    beforeEach(async () => {
        issuer = await startIssuerTestServer("test");
        upstream = await startUpstreamServer();
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await issuer.close();
        await upstream.close();
    });

    it("accepts the configured issuer under every run mode and setting combination", async () => {
        const runModes: GatewayConfig["runMode"][] = ["PROD", "DEV"];
        for (const runMode of runModes) {
            for (const allowTokenIssuerHostMismatch of [false, true]) {
                const app = await createIssuerScopedApp(issuer, upstream, runMode, allowTokenIssuerHostMismatch);
                const response = await app.requestPatient(issuer.issuerUrl);

                expect({ runMode, allowTokenIssuerHostMismatch, status: response.status }).toEqual({
                    runMode,
                    allowTokenIssuerHostMismatch,
                    status: 200,
                });
            }
        }
    });

    it("accepts a differing issuer in DEV mode with a warning", async () => {
        const app = await createIssuerScopedApp(issuer, upstream, "DEV", false);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

        const response = await app.requestPatient(`${issuer.issuerUrl}/emulator`);

        expect(response.status).toBe(200);
        expect(warn).toHaveBeenCalled();
    });

    it("accepts a realm-pathname-equivalent issuer when the host mismatch setting is enabled", async () => {
        const app = await createIssuerScopedApp(issuer, upstream, "PROD", true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const altIssuer = `http://issuer-alias.example:${new URL(issuer.issuerUrl).port}`;

        const response = await app.requestPatient(altIssuer);

        expect(response.status).toBe(200);
        expect(warn).toHaveBeenCalled();
    });

    it("rejects a realm-pathname-equivalent issuer when the host mismatch setting is disabled", async () => {
        const app = await createIssuerScopedApp(issuer, upstream, "PROD", false);
        const altIssuer = `http://issuer-alias.example:${new URL(issuer.issuerUrl).port}`;

        const response = await app.requestPatient(altIssuer);

        expect(response.status).toBe(401);
    });

    it("rejects an issuer that matches no strategy even when the host mismatch setting is enabled", async () => {
        const app = await createIssuerScopedApp(issuer, upstream, "PROD", true);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const altIssuer = `http://issuer-alias.example:${new URL(issuer.issuerUrl).port}/other-realm`;

        const response = await app.requestPatient(altIssuer);

        expect(response.status).toBe(401);
        expect(warn).not.toHaveBeenCalled();
    });
});

describe("Issuer policy module surface", () => {
    it("exposes the policy as the only entry point", () => {
        expect(Object.keys(issuerPolicyModule)).toEqual(["createIssuerPolicy"]);
    });
});
