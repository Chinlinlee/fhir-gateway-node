import { generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthenticationError } from "../src/errors/authentication.error";
import { TokenVerifierService } from "../src/services/token-verifier.service";
import { type IssuerTestServer, signTestJwt, startIssuerTestServer } from "./helpers/issuer-test-server";

describe("TokenVerifierService", () => {
    let server: IssuerTestServer;
    let verifier: TokenVerifierService;

    beforeEach(async () => {
        server = await startIssuerTestServer("test");
        verifier = await TokenVerifierService.create({
            tokenIssuer: server.issuerUrl,
            wellKnownEndpoint: server.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: false,
        });
    });

    afterEach(async () => {
        await server.close();
    });

    it("decodeAndVerifyBearerToken — valid JWT", async () => {
        const token = await signTestJwt(server.issuerUrl, server.keys.privateKey);
        const verified = await verifier.decodeAndVerifyBearerToken(`Bearer ${token}`);
        expect(verified.payload.iss).toBe(server.issuerUrl);
    });

    it("decodeAndVerifyBearerTokenWrongIssuer — rejects mismatched iss in PROD", async () => {
        const token = await signTestJwt(`${server.issuerUrl}WRONG`, server.keys.privateKey);
        await expect(verifier.decodeAndVerifyBearerToken(`Bearer ${token}`)).rejects.toBeInstanceOf(
            AuthenticationError,
        );
    });

    it("decodeAndVerifyBearerTokenBadSignature — rejects invalid signature", async () => {
        const { privateKey: wrongPrivateKey } = await generateKeyPair("RS256", {
            extractable: true,
        });
        const token = await signTestJwt(server.issuerUrl, wrongPrivateKey);
        await expect(verifier.decodeAndVerifyBearerToken(`Bearer ${token}`)).rejects.toBeInstanceOf(
            AuthenticationError,
        );
    });

    it("decodeAndVerifyBearerTokenNoBearer — rejects missing Bearer prefix", async () => {
        const token = await signTestJwt(server.issuerUrl, server.keys.privateKey);
        await expect(verifier.decodeAndVerifyBearerToken(token)).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("decodeAndVerifyBearerTokenMalformedBearer — rejects malformed prefix", async () => {
        const token = await signTestJwt(server.issuerUrl, server.keys.privateKey);
        await expect(verifier.decodeAndVerifyBearerToken(`BearerTTT ${token}`)).rejects.toBeInstanceOf(
            AuthenticationError,
        );
    });

    it("decodeAndVerifyBearerTokenMalformedToken — rejects malformed JWT", async () => {
        await expect(verifier.decodeAndVerifyBearerToken("Bearer TTT")).rejects.toBeInstanceOf(AuthenticationError);
    });

    it("getWellKnownConfig — returns OIDC discovery JSON", () => {
        expect(verifier.getWellKnownConfig()).toBe(server.wellKnownConfig);
    });

    it("rejects issuer host mismatch in PROD when ALLOW_TOKEN_ISSUER_HOST_MISMATCH is false", async () => {
        const configured = new URL(server.issuerUrl);
        const altIssuer = `http://issuer-alias.example:${configured.port}`;
        const token = await signTestJwt(altIssuer, server.keys.privateKey);
        await expect(verifier.decodeAndVerifyBearerToken(`Bearer ${token}`)).rejects.toBeInstanceOf(
            AuthenticationError,
        );
    });

    it("allows issuer host mismatch in PROD when ALLOW_TOKEN_ISSUER_HOST_MISMATCH is true", async () => {
        const relaxedVerifier = await TokenVerifierService.create({
            tokenIssuer: server.issuerUrl,
            wellKnownEndpoint: server.wellKnownPath,
            runMode: "PROD",
            allowTokenIssuerHostMismatch: true,
        });
        const configured = new URL(server.issuerUrl);
        const altIssuer = `http://issuer-alias.example:${configured.port}`;
        const token = await signTestJwt(altIssuer, server.keys.privateKey);
        const verified = await relaxedVerifier.decodeAndVerifyBearerToken(`Bearer ${token}`);
        expect(verified.payload.iss).toBe(altIssuer);
    });

    it("allows issuer mismatch when RUN_MODE is DEV", async () => {
        await server.close();
        server = await startIssuerTestServer("test");
        const devVerifier = await TokenVerifierService.create({
            tokenIssuer: server.issuerUrl,
            wellKnownEndpoint: server.wellKnownPath,
            runMode: "DEV",
            allowTokenIssuerHostMismatch: false,
        });
        const altIssuer = `${server.issuerUrl}/emulator`;
        const token = await signTestJwt(altIssuer, server.keys.privateKey);
        const verified = await devVerifier.decodeAndVerifyBearerToken(`Bearer ${token}`);
        expect(verified.payload.iss).toBe(altIssuer);
    });
});
