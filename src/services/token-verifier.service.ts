import type { JWTVerifyOptions } from "jose";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";

import type { GatewayConfig } from "../configs/env.schema";
import { BEARER_PREFIX, SIGN_ALGORITHM } from "../constants/auth";
import { DEFAULT_SIGNING_KEY_SOURCE } from "../constants/config";
import { AuthenticationError } from "../errors/authentication.error";
import type { VerifiedJwt } from "../types/verified-jwt";
import { HttpUtil } from "../utils/http.util";
import { resolveExpectedAudiences } from "./audience-policy/audience-policy";
import type { IssuerPolicy } from "./issuer-policy/issuer-policy";
import { createIssuerPolicy } from "./issuer-policy/issuer-policy";
import type { ResolvedSigningKeys, SigningKeyResolver } from "./signing-keys/signing-key-resolver";
import { resolveSigningKeys } from "./signing-keys/signing-key-resolver";

type TokenVerifierConfig = Pick<
    GatewayConfig,
    | "tokenIssuer"
    | "wellKnownEndpoint"
    | "runMode"
    | "allowTokenIssuerHostMismatch"
    | "signingKeySource"
    | "tokenAudience"
>;

/**
 * Verifies OAuth 2.0 Bearer JWT (RS256), 驗簽金鑰由 signing key resolver 提供，
 * issuer 比對委由 issuer policy 決定。
 */
export class TokenVerifierService {
    private readonly issuerPolicy: IssuerPolicy;
    private readonly expectedAudiences: string[] | undefined;
    private readonly discoveryDocument: string;
    private readonly signingKeyResolver: SigningKeyResolver;

    private constructor(
        issuerPolicy: IssuerPolicy,
        expectedAudiences: string[] | undefined,
        discoveryDocument: string,
        signingKeyResolver: SigningKeyResolver,
    ) {
        this.issuerPolicy = issuerPolicy;
        this.expectedAudiences = expectedAudiences;
        this.discoveryDocument = discoveryDocument;
        this.signingKeyResolver = signingKeyResolver;
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
            createIssuerPolicy(config),
            resolveExpectedAudiences(config.tokenAudience),
            resolved.discoveryDocument,
            resolved.resolver,
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
        return {
            issuer: this.issuerPolicy.resolveVerificationIssuer(jwtIssuer),
            algorithms: [SIGN_ALGORITHM],
            // jose 在 `audience` 有值時會要求 `aud` claim 存在，並以集合語意比對
            // （token 的多個 aud 值任一命中即接受；單一字串與單元素陣列皆可）。
            // 失敗訊息只描述失敗類別，不會帶出本 RS 接受哪些 aud 值。
            ...(this.expectedAudiences ? { audience: this.expectedAudiences } : {}),
        };
    }
}
