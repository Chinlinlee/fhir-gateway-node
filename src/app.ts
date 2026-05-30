import { node } from "@elysia/node";
import { Elysia } from "elysia";

import type { GatewayConfig } from "./configs/env.schema";
import { corsPlugin } from "./middlewares/cors";
import { fhirRoute } from "./routes/fhir.route";
import { healthRoute } from "./routes/health.route";
import { wellKnownRoute } from "./routes/well-known.route";
import type { AccessCheckerRegistryService } from "./services/access-checker-registry.service";
import { createDefaultAccessCheckerRegistry } from "./services/access-checker-registry.service";
import { AllowedQueriesCheckerService } from "./services/allowed-queries.service";
import { AuditEventService } from "./services/audit-event.service";
import { FhirBackendService } from "./services/fhir-backend.service";
import { HttpFhirClientService } from "./services/http-fhir-client.service";
import { PatientFinderService } from "./services/patient-finder.service";
import type { TokenVerifierService } from "./services/token-verifier.service";

export type CreateAppOptions = {
    tokenVerifier?: TokenVerifierService;
    config?: GatewayConfig;
    allowedQueries?: AllowedQueriesCheckerService;
    accessCheckerRegistry?: AccessCheckerRegistryService;
    patientFinder?: PatientFinderService;
    httpFhirClient?: HttpFhirClientService;
    auditEventService?: AuditEventService;
};

export const createApp = (options?: CreateAppOptions) => {
    const app = new Elysia({ adapter: node() }).use(corsPlugin).use(healthRoute);

    if (options?.tokenVerifier) {
        app.use(wellKnownRoute(options.tokenVerifier));
    }

    if (options?.tokenVerifier && options.config) {
        app.use(
            fhirRoute({
                config: options.config,
                tokenVerifier: options.tokenVerifier,
                allowedQueries:
                    options.allowedQueries ??
                    AllowedQueriesCheckerService.loadFromFile(options.config.allowedQueriesFile),
                accessCheckerRegistry: options.accessCheckerRegistry ?? createDefaultAccessCheckerRegistry(),
                patientFinder: options.patientFinder ?? PatientFinderService.getInstance(),
                httpFhirClient:
                    options.httpFhirClient ??
                    new HttpFhirClientService({
                        proxyTo: options.config.proxyTo,
                        backendType: options.config.backendType,
                    }),
                auditEventService:
                    options.auditEventService ?? new AuditEventService(new FhirBackendService({ baseUrl: options.config.proxyTo })),
            }),
        );
    }

    return app;
};

export type App = ReturnType<typeof createApp>;
