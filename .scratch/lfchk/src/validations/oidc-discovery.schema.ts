import { z } from "zod";

/**
 * OIDC discovery document proxied from TOKEN_ISSUER (Keycloak-style).
 */
export const OidcDiscoverySchema = z
    .object({
        issuer: z.string(),
        authorization_endpoint: z.string(),
        token_endpoint: z.string(),
        jwks_uri: z.string(),
        grant_types_supported: z.array(z.string()),
        response_types_supported: z.array(z.string()),
        subject_types_supported: z.array(z.string()),
        id_token_signing_alg_values_supported: z.array(z.string()),
        code_challenge_methods_supported: z.array(z.string()),
    })
    .loose();

export type OidcDiscovery = z.infer<typeof OidcDiscoverySchema>;
