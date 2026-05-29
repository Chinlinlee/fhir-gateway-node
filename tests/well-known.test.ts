import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import { FHIR_API_PREFIX, WELL_KNOWN_SMART_CONFIGURATION_PATH } from "../src/constants/routes";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, startIssuerTestServer } from "./helpers/issuer-test-server";

const WELL_KNOWN_URL = `${FHIR_API_PREFIX}/${WELL_KNOWN_SMART_CONFIGURATION_PATH}`;

describe("GET /fhir/.well-known/smart-configuration", () => {
    let server: IssuerTestServer;
    let app: ReturnType<typeof createApp>;

    beforeEach(async () => {
        server = await startIssuerTestServer("test");
        const tokenVerifier = await TokenVerifierService.create({
            tokenIssuer: server.issuerUrl,
            wellKnownEndpoint: server.wellKnownPath,
            runMode: "PROD",
        });
        app = createApp({ tokenVerifier });
    });

    afterEach(async () => {
        await server.close();
    });

    it("authorizeRequestWellKnown — returns OIDC discovery without Authorization", async () => {
        const response = await app.handle(new Request(`http://localhost${WELL_KNOWN_URL}`, { method: "GET" }));

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");

        const body = (await response.json()) as Record<string, unknown>;

        expect(body.issuer).toBe("https://token.issuer/realms/test");
        expect(body.authorization_endpoint).toBe("https://token.issuer/protocol/openid-connect/auth");
        expect(body.token_endpoint).toBe("https://token.issuer/protocol/openid-connect/token");
        expect(body.jwks_uri).toBe("https://token.issuer/protocol/openid-connect/certs");
        expect(body.grant_types_supported).toEqual(["authorization_code"]);
        expect(body.response_types_supported).toEqual([
            "code",
            "none",
            "id_token",
            "token",
            "id_token token",
            "code id_token",
            "code token",
            "code id_token token",
        ]);
        expect(body.subject_types_supported).toEqual(["public", "pairwise"]);
        expect(body.id_token_signing_alg_values_supported).toEqual([
            "PS384",
            "ES384",
            "RS384",
            "HS256",
            "HS512",
            "ES256",
            "RS256",
            "HS384",
            "ES512",
            "PS256",
            "PS512",
            "RS512",
        ]);
        expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    });
});
