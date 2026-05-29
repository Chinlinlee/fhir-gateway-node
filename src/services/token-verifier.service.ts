import { createPublicKey, type KeyObject } from "node:crypto";

import { decodeJwt, decodeProtectedHeader, jwtVerify, type JWTVerifyOptions } from "jose";

import type { GatewayConfig } from "../configs/env.schema";
import { BEARER_PREFIX, SIGN_ALGORITHM } from "../constants/auth";
import { AuthenticationError } from "../errors/authentication.error";
import type { VerifiedJwt } from "../types/verified-jwt";
import { HttpUtil } from "../utils/http.util";
import { IssuerMetadataSchema } from "../validations/issuer-metadata.schema";

type TokenVerifierConfig = Pick<GatewayConfig, "tokenIssuer" | "wellKnownEndpoint" | "runMode">;

/**
 * Verifies OAuth 2.0 Bearer JWT (RS256 + Keycloak public_key).
 */
export class TokenVerifierService {
    private readonly tokenIssuer: string;
    private readonly wellKnownConfigJson: string;
    private readonly publicKey: KeyObject;
    private readonly devMode: boolean;

    private constructor(tokenIssuer: string, wellKnownConfigJson: string, publicKey: KeyObject, devMode: boolean) {
        this.tokenIssuer = tokenIssuer;
        this.wellKnownConfigJson = wellKnownConfigJson;
        this.publicKey = publicKey;
        this.devMode = devMode;
    }

    static async create(
        config: TokenVerifierConfig,
        httpUtil: HttpUtil = new HttpUtil(),
    ): Promise<TokenVerifierService> {
        const publicKey = await TokenVerifierService.fetchAndDecodePublicKey(config.tokenIssuer, httpUtil);
        const wellKnownConfigJson = await httpUtil.fetchWellKnownConfig(config.tokenIssuer, config.wellKnownEndpoint);

        return new TokenVerifierService(config.tokenIssuer, wellKnownConfigJson, publicKey, config.runMode === "DEV");
    }

    getWellKnownConfig(): string {
        return this.wellKnownConfigJson;
    }

    /**
     * Decode Authorization header and verify JWT.
     */
    async decodeAndVerifyBearerToken(authHeader: string): Promise<VerifiedJwt> {
        if (!authHeader.startsWith(BEARER_PREFIX)) {
            throw new AuthenticationError("Authorization header is not a valid Bearer token!");
        }

        const bearerToken = authHeader.slice(BEARER_PREFIX.length);

        let unverifiedPayload: ReturnType<typeof decodeJwt>;
        try {
            unverifiedPayload = decodeJwt(bearerToken);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown decode error";
            throw new AuthenticationError(`Failed to decode JWT: ${message}`);
        }

        const issuer = unverifiedPayload.iss;
        if (typeof issuer !== "string" || issuer.length === 0) {
            throw new AuthenticationError("JWT is missing issuer (iss) claim");
        }

        const { alg: algorithm } = decodeProtectedHeader(bearerToken);
        if (algorithm !== SIGN_ALGORITHM) {
            throw new AuthenticationError(
                `Only ${SIGN_ALGORITHM} signing algorithm is supported, got ${String(algorithm)}`,
            );
        }

        const verifyOptions = this.buildVerifyOptions(issuer);

        try {
            const result = await jwtVerify(bearerToken, this.publicKey, verifyOptions);
            return {
                payload: result.payload,
                protectedHeader: result.protectedHeader,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown verification error";
            throw new AuthenticationError(`JWT verification failed with error: ${message}`);
        }
    }

    private buildVerifyOptions(issuer: string): JWTVerifyOptions {
        if (issuer !== this.tokenIssuer) {
            if (this.devMode) {
                // DEV: Android emulator may use a different issuer URL / DEV 模式容忍 issuer 與設定不同
                console.warn("Server run in DEV mode. Setting issuer to issuer from request.");
                return {
                    issuer,
                    algorithms: [SIGN_ALGORITHM],
                };
            }

            throw new AuthenticationError(`The token issuer ${issuer} does not match the expected token issuer`);
        }

        return {
            issuer: this.tokenIssuer,
            algorithms: [SIGN_ALGORITHM],
        };
    }

    private static async fetchAndDecodePublicKey(tokenIssuer: string, httpUtil: HttpUtil): Promise<KeyObject> {
        const body = await httpUtil.getText(tokenIssuer);
        let json: unknown;
        try {
            json = JSON.parse(body) as unknown;
        } catch {
            throw new AuthenticationError("Cannot parse issuer metadata as JSON for public_key");
        }

        const parsed = IssuerMetadataSchema.safeParse(json);
        if (!parsed.success) {
            throw new AuthenticationError("Cannot find 'public_key' in issuer metadata.");
        }

        try {
            // Keycloak returns X.509 SPKI DER as base64 (Java X509EncodedKeySpec).
            return createPublicKey({
                key: Buffer.from(parsed.data.public_key, "base64"),
                format: "der",
                type: "spki",
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid key material";
            throw new AuthenticationError(`Invalid KeySpec: ${message}`);
        }
    }
}
