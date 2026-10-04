import { createServer, type Server } from "node:http";

import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { GatewayConfig } from "../src/configs/env.schema";
import { FHIR_API_PREFIX } from "../src/constants/routes";
import { PATIENT_CLAIM } from "../src/services/access-checkers/patient-access-checker.service";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "../tests/helpers/issuer-test-server";

describe("probe: whitespace-padded patient claim", () => {
    let issuer: IssuerTestServer;
    let upstream: Server;
    let upstreamBase: string;
    let lastQuery: string | null = null;

    beforeEach(async () => {
        issuer = await startIssuerTestServer();
        lastQuery = null;
        upstream = createServer((req, res) => {
            const url = new URL(req.url ?? "/", "http://127.0.0.1");
            if (url.pathname === "/fhir/Observation/enc-1") {
                lastQuery = url.search;
                res.writeHead(200, { "content-type": "application/fhir+json" });
                res.end(JSON.stringify({ resourceType: "Observation", id: "enc-1" }));
                return;
            }
            res.writeHead(404, { "content-type": "application/fhir+json" });
            res.end("{}");
        });
        await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
        const addr = upstream.address();
        if (addr === null || typeof addr === "string") throw new Error("no addr");
        upstreamBase = `http://127.0.0.1:${addr.port}`;
    });

    afterEach(async () => {
        await issuer.close();
        await new Promise<void>((r) => upstream.close(() => r()));
    });

    it("reports status + upstream query for a padded patient claim", async () => {
        const config: GatewayConfig = {
            proxyTo: `${upstreamBase}/fhir`,
            tokenIssuer: issuer.issuerUrl,
            backendType: "HAPI",
            accessChecker: "patient",
            auditEventActions: [],
            wellKnownEndpoint: "test",
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
            port: 3000,
        };
        const tokenVerifier = new TokenVerifierService(config);
        const app = createApp({ tokenVerifier, config });
        const jwt = await new SignJWT({
            [PATIENT_CLAIM]: " 456 ",
            scope: "patient/Observation.read",
        })
            .setProtectedHeader({ alg: "RS256" })
            .setIssuer(issuer.issuerUrl)
            .setSubject("gateway-user")
            .sign(issuer.keys.privateKey);

        const response = await app.handle(
            new Request(`http://localhost${FHIR_API_PREFIX}/Observation/enc-1`, {
                headers: { Authorization: `Bearer ${jwt}` },
            }),
        );
        const body = await response.text();
        console.log("PROBE status=", response.status, "upstreamQuery=", lastQuery, "body=", body);
        expect(true).toBe(true);
    });
});