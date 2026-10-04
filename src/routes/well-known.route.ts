import { Elysia } from "elysia";

import { FHIR_API_PREFIX, WELL_KNOWN_SMART_CONFIGURATION_PATH } from "../constants/routes";
import { WellKnownController } from "../controllers/well-known/well-known.controller";
import type { TokenVerifierService } from "../services/token-verifier.service";
import { OidcDiscoverySchema } from "../validations/oidc-discovery.schema";

/**
 * SMART well-known endpoint — public, no JWT (SPEC §5.2).
 *
 * 代理 authorization flow 時（`publicBaseUrl` 有設定），`authorization_endpoint` 與
 * `token_endpoint` 改指 gateway 自己，`issuer` 維持 IdP 的原值。
 */
export const wellKnownRoute = (tokenVerifier: TokenVerifierService, publicBaseUrl?: string) =>
    new Elysia({ name: "well-known", prefix: FHIR_API_PREFIX }).get(
        `/${WELL_KNOWN_SMART_CONFIGURATION_PATH}`,
        ({ set }) => {
            set.headers["content-type"] = "application/json; charset=UTF-8";
            return publicBaseUrl === undefined
                ? WellKnownController.getSmartConfiguration(tokenVerifier)
                : WellKnownController.getProxiedSmartConfiguration(tokenVerifier, publicBaseUrl);
        },
        {
            response: OidcDiscoverySchema,
        },
    );
