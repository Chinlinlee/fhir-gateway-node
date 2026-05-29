import { Elysia } from "elysia";

import { FHIR_API_PREFIX, WELL_KNOWN_SMART_CONFIGURATION_PATH } from "../constants/routes";
import { WellKnownController } from "../controllers/well-known/well-known.controller";
import type { TokenVerifierService } from "../services/token-verifier.service";
import { OidcDiscoverySchema } from "../validations/oidc-discovery.schema";

/**
 * SMART well-known endpoint — public, no JWT (SPEC §5.2).
 */
export const wellKnownRoute = (tokenVerifier: TokenVerifierService) =>
    new Elysia({ name: "well-known", prefix: FHIR_API_PREFIX }).get(
        `/${WELL_KNOWN_SMART_CONFIGURATION_PATH}`,
        ({ set }) => {
            set.headers["content-type"] = "application/json; charset=UTF-8";
            return WellKnownController.getSmartConfiguration(tokenVerifier);
        },
        {
            response: OidcDiscoverySchema,
        },
    );
