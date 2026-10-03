import type { JWTVerifyOptions } from "jose";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

import type { GatewayConfig } from "../configs/env.schema";
import { BEARER_PREFIX, SIGN_ALGORITHM } from "../constants/auth";
import { DEFAULT_SIGNING_KEY_SOURCE } from "../constants/config";
import { AuthenticationError } from "../errors/authentication.error";
import type { VerifiedJwt } from "../types/verified-jwt";
import { HttpUtil } from "../utils/http.util";
import type { ResolvedSigningKeys, SigningKeyResolver } from "./signing-keys/signing-key-resolver";
import { resolveSigningKeys } from "./signing-keys/signing-key-resolver";

type TokenVerifierConfig = Pick<
    GatewayConfig,
    "tokenIssuer" | "wellKnownEndpoint" | "runMode" | "allowTokenIssuerHostMismatch" | "signingKeySource"
>;

function normalizeIssuerPath(issuerUrl: string): string {
    try {
        const pathname = new URL(issuerUrl).pathname.replace(/\/+$/, "");
        return pathname.length > 0 ? pathname : "/";
    } catch {
        return issuerUrl;
    }
}

/**
 * Verifies OAuth 2.0 Bearer JWT (RS256), 驗簽金鑰由 signing key resolver 提供。
 */
export class TokenVerifierService {
    private readonly tokenIssuer: string;
    private readonly discoveryDocument: string;
    private readonly signingKeyResolver: SigningKeyResolver;
    private readonly devMode: boolean;
    private readonly allowTokenIssuerHostMismatch: boolean;

    private constructor(
        tokenIssuer: string,
        discoveryDocument: string,
        signingKeyResolver: SigningKeyResolver,
        devMode: boolean,
        allowTokenIssuerHostMismatch: boolean,
    ) {
        this.tokenIssuer = tokenIssuer;
        this.discoveryDocument = discoveryDocument;
        this.signingKeyResolver = signingKeyResolver;
        this.devMode = devMode;
        this.allowTokenIssuerHostMismatch = allowTokenIssuerHostMismatch;
    }

    /**
     * @param signingKeys 已解析好的驗簽金鑰來源；未提供時依 SIGNING_KEY_SOURCE 於啟動時解析。
     */
    static async create(
        config: TokenVerifierConfig,
        httpUtil: HttpUtil = new HttpUtil(),
        signingKeys?: ResolvedSigningKeys,
    ): Promise<TokenVerifierService> {
        const resolved =
            signingKeys ??
            (await resolveSigningKeys({
                tokenIssuer: config.tokenIssuer,
                wellKnownEndpoint: config.wellKnownEndpoint,
                signingKeySource: config.signingKeySource ?? DEFAULT_SIGNING_KEY_SOURCE,
                httpUtil,
            }));

        return new TokenVerifierService(
            config.tokenIssuer,
            resolved.discoveryDocument,
            resolved.resolver,
            config.runMode === "DEV",
            config.allowTokenIssuerHostMismatch,
        );
    }

    getWellKnownConfig(): string {
        return this.discoveryDocument;
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
            const result = await jwtVerify(
                bearerToken,
                (protectedHeader) => this.signingKeyResolver.resolveVerificationKey(protectedHeader),
                verifyOptions,
            );
            return {
                payload: result.payload,
                protectedHeader: result.protectedHeader,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown verification error";
            throw new AuthenticationError(`JWT verification failed with error: ${message}`);
        }
    }

    private buildVerifyOptions(jwtIssuer: string): JWTVerifyOptions {
        const verifyIssuer = this.resolveVerifyIssuer(jwtIssuer);
        return {
            issuer: verifyIssuer,
            algorithms: [SIGN_ALGORITHM],
        };
    }

    /**
     * 決定 jwtVerify 使用的 issuer。
     * PROD 需 ALLOW_TOKEN_ISSUER_HOST_MISMATCH=true 才接受 host 不同、realm path 相同。
     */
    private resolveVerifyIssuer(jwtIssuer: string): string {
        if (jwtIssuer === this.tokenIssuer) {
            return this.tokenIssuer;
        }

        if (this.devMode) {
            // DEV: Android emulator may use a different issuer URL / DEV 模式容忍 issuer 與設定不同
            console.warn(
                `RUN_MODE=DEV: JWT iss=${jwtIssuer} differs from TOKEN_ISSUER=${this.tokenIssuer}; verifying with token iss`,
            );
            return jwtIssuer;
        }

        if (this.allowTokenIssuerHostMismatch) {
            const configuredPath = normalizeIssuerPath(this.tokenIssuer);
            const jwtPath = normalizeIssuerPath(jwtIssuer);
            if (configuredPath === jwtPath) {
                console.warn(
                    `ALLOW_TOKEN_ISSUER_HOST_MISMATCH: iss=${jwtIssuer}, TOKEN_ISSUER=${this.tokenIssuer}; verifying with token iss (realm path ${configuredPath})`,
                );
                return jwtIssuer;
            }
        }

        throw new AuthenticationError(
            `The token issuer ${jwtIssuer} does not match the expected token issuer ${this.tokenIssuer}`,
        );
    }
}
