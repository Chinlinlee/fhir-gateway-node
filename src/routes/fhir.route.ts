import { Elysia } from "elysia";

import type { GatewayConfig } from "../configs/env.schema";
import { FHIR_API_PREFIX } from "../constants/routes";
import { FhirProxyController } from "../controllers/fhir-proxy.controller";
import type { AccessCheckerRegistryService } from "../services/access-checker-registry.service";
import type { AllowedQueriesCheckerService } from "../services/allowed-queries.service";
import type { AuditEventService } from "../services/audit-event.service";
import type { HttpFhirClientService } from "../services/http-fhir-client.service";
import type { PatientFinderService } from "../services/patient-finder.service";
import type { TokenVerifierService } from "../services/token-verifier.service";

import type { AsyncFhirClientLike } from "../types/http-fhir-client";
import type { LaunchContextProvider } from "../types/launch-context";

export type FhirRouteDeps = {
    config: GatewayConfig;
    tokenVerifier: TokenVerifierService;
    /** 非同步 FHIR client；list checker 於 prepare 階段用它查詢 backend。 */
    fhirBackend?: AsyncFhirClientLike;
    httpFhirClient: HttpFhirClientService;
    allowedQueries: AllowedQueriesCheckerService;
    accessCheckerRegistry: AccessCheckerRegistryService;
    launchContextProvider: LaunchContextProvider;
    patientFinder: PatientFinderService;
    auditEventService?: AuditEventService;
};

export const fhirRoute = (deps: FhirRouteDeps) =>
    new Elysia({ name: "fhir-proxy", prefix: FHIR_API_PREFIX }).all("/*", async ({ request, params }) =>
        FhirProxyController.handle(request, params["*"] ?? "", deps, FHIR_API_PREFIX),
    );
