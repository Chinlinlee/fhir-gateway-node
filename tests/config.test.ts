import { describe, expect, it } from "vitest";
import { ConfigError, loadGatewayConfig, minimalValidEnv } from "../src/configs";

describe("loadGatewayConfig", () => {
    it("load minimal valid configuration", () => {
        const config = loadGatewayConfig(minimalValidEnv());

        expect(config.proxyTo).toBe("http://localhost:8080/fhir");
        expect(config.tokenIssuer).toBe("http://localhost:9080/auth/realms/test");
        expect(config.backendType).toBe("HAPI");
        expect(config.accessChecker).toBe("patient");
        expect(config.runMode).toBe("PROD");
        expect(config.wellKnownEndpoint).toBe(".well-known/openid-configuration");
        expect(config.auditEventActions).toEqual([]);
    });

    it("strips trailing slash from PROXY_TO", () => {
        const config = loadGatewayConfig(
            minimalValidEnv({
                PROXY_TO: "http://localhost:8080/fhir/",
            }),
        );
        expect(config.proxyTo).toBe("http://localhost:8080/fhir");
    });

    it("throws when PROXY_TO is missing", () => {
        const env = minimalValidEnv();
        delete env.PROXY_TO;
        expect(() => loadGatewayConfig(env)).toThrow(ConfigError);
    });

    it("throws when BACKEND_TYPE is invalid", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ BACKEND_TYPE: "MYSQL" }))).toThrow(/GCP or HAPI/);
    });

    it("parses AUDIT_EVENT_ACTIONS_CONFIG as per-character codes", () => {
        const config = loadGatewayConfig(minimalValidEnv({ AUDIT_EVENT_ACTIONS_CONFIG: "CR" }));
        expect(config.auditEventActions).toEqual(["C", "R"]);
    });
    it("throws on invalid audit action code", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ AUDIT_EVENT_ACTIONS_CONFIG: "CRX" }))).toThrow(
            /Invalid AuditEvent Action/,
        );
    });
    it("allows permissive access checker only in DEV mode", () => {
        const devConfig = loadGatewayConfig(
            minimalValidEnv({
                ACCESS_CHECKER: "permissive",
                RUN_MODE: "DEV",
            }),
        );
        expect(devConfig.accessChecker).toBe("permissive");
        expect(devConfig.runMode).toBe("DEV");
        expect(() =>
            loadGatewayConfig(
                minimalValidEnv({
                    ACCESS_CHECKER: "permissive",
                    RUN_MODE: "PROD",
                }),
            ),
        ).toThrow(/permissive/);
    });

    it("defaults RUN_MODE to PROD", () => {
        const env = minimalValidEnv();
        delete env.RUN_MODE;
        expect(loadGatewayConfig(env).runMode).toBe("PROD");
    });

    it("defaults ALLOW_TOKEN_ISSUER_HOST_MISMATCH to false", () => {
        const config = loadGatewayConfig(minimalValidEnv());
        expect(config.allowTokenIssuerHostMismatch).toBe(false);
    });

    it("parses ALLOW_TOKEN_ISSUER_HOST_MISMATCH", () => {
        const enabled = loadGatewayConfig(minimalValidEnv({ ALLOW_TOKEN_ISSUER_HOST_MISMATCH: "true" }));
        expect(enabled.allowTokenIssuerHostMismatch).toBe(true);

        const disabled = loadGatewayConfig(minimalValidEnv({ ALLOW_TOKEN_ISSUER_HOST_MISMATCH: "off" }));
        expect(disabled.allowTokenIssuerHostMismatch).toBe(false);
    });

    it("throws on invalid ALLOW_TOKEN_ISSUER_HOST_MISMATCH", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ ALLOW_TOKEN_ISSUER_HOST_MISMATCH: "maybe" }))).toThrow(
            /ALLOW_TOKEN_ISSUER_HOST_MISMATCH/,
        );
    });

    it("reads WELL_KNOWN_ENDPOINT from environment", () => {
        const config = loadGatewayConfig(
            minimalValidEnv({
                WELL_KNOWN_ENDPOINT: ".well-known/custom",
            }),
        );
        expect(config.wellKnownEndpoint).toBe(".well-known/custom");
    });

    it("defaults SIGNING_KEY_SOURCE to auto", () => {
        const config = loadGatewayConfig(minimalValidEnv());
        expect(config.signingKeySource).toBe("auto");
    });

    it("parses SIGNING_KEY_SOURCE", () => {
        const jwks = loadGatewayConfig(minimalValidEnv({ SIGNING_KEY_SOURCE: "JWKS" }));
        expect(jwks.signingKeySource).toBe("jwks");

        const keycloak = loadGatewayConfig(minimalValidEnv({ SIGNING_KEY_SOURCE: "keycloak-public-key" }));
        expect(keycloak.signingKeySource).toBe("keycloak-public-key");
    });

    it("throws on invalid SIGNING_KEY_SOURCE", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ SIGNING_KEY_SOURCE: "keycloak" }))).toThrow(
            /SIGNING_KEY_SOURCE/,
        );
    });

    it("leaves the proxied authorization flow off when GATEWAY_PUBLIC_BASE_URL is unset", () => {
        const config = loadGatewayConfig(minimalValidEnv());

        expect(config.gatewayPublicBaseUrl).toBeUndefined();
        expect(config.gatewayClientId).toBeUndefined();
    });

    it("reads the gateway public base URL and IdP client credentials", () => {
        const config = loadGatewayConfig(
            minimalValidEnv({
                GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.org",
                GATEWAY_CLIENT_ID: "gateway",
                GATEWAY_CLIENT_SECRET: "shhh",
            }),
        );

        expect(config.gatewayPublicBaseUrl).toBe("https://gateway.example.org");
        expect(config.gatewayClientId).toBe("gateway");
        expect(config.gatewayClientSecret).toBe("shhh");
    });

    it("throws naming the missing credential when the authorization flow is enabled without one", () => {
        expect(() =>
            loadGatewayConfig(minimalValidEnv({ GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.org" })),
        ).toThrow(/GATEWAY_CLIENT_ID/);

        expect(() =>
            loadGatewayConfig(
                minimalValidEnv({
                    GATEWAY_PUBLIC_BASE_URL: "https://gateway.example.org",
                    GATEWAY_CLIENT_ID: "gateway",
                }),
            ),
        ).toThrow(/GATEWAY_CLIENT_SECRET/);
    });

    it("keeps the launch context store in memory unless an operator asks for another one", () => {
        const config = loadGatewayConfig(minimalValidEnv());

        expect(config.launchContextStoreType).toBe("memory");
        expect(config.launchContextValkeyUrl).toBeUndefined();
    });

    it("parses LAUNCH_CONTEXT_STORE", () => {
        const config = loadGatewayConfig(
            minimalValidEnv({
                LAUNCH_CONTEXT_STORE: "valkey",
                LAUNCH_CONTEXT_VALKEY_URL: "rediss://gateway:shhh@valkey.internal:6379",
            }),
        );

        expect(config.launchContextStoreType).toBe("valkey");
        expect(config.launchContextValkeyUrl).toBe("rediss://gateway:shhh@valkey.internal:6379");
    });

    it("throws on invalid LAUNCH_CONTEXT_STORE", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ LAUNCH_CONTEXT_STORE: "postgres" }))).toThrow(
            /LAUNCH_CONTEXT_STORE/,
        );
    });

    it("throws naming the missing URL when the valkey store is selected without one", () => {
        expect(() => loadGatewayConfig(minimalValidEnv({ LAUNCH_CONTEXT_STORE: "valkey" }))).toThrow(
            /LAUNCH_CONTEXT_VALKEY_URL/,
        );
    });
});
