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
import { GcpAccessTokenProviderService } from "./services/gcp-access-token-provider.service";
import { HttpFhirClientService } from "./services/http-fhir-client.service";
import { defaultLaunchContextProvider } from "./services/launch-context.service";
import { PatientFinderService } from "./services/patient-finder.service";
import type { TokenVerifierService } from "./services/token-verifier.service";
import type { LaunchContextProvider } from "./types/launch-context";

export type CreateAppOptions = {
    tokenVerifier?: TokenVerifierService;
    launchContextProvider?: LaunchContextProvider;
    config?: GatewayConfig;
    allowedQueries?: AllowedQueriesCheckerService;
    accessCheckerRegistry?: AccessCheckerRegistryService;
    patientFinder?: PatientFinderService;
    httpFhirClient?: HttpFhirClientService;
    fhirBackend?: FhirBackendService;
    auditEventService?: AuditEventService;
};

export const createApp = (options?: CreateAppOptions) => {
    const app = new Elysia({ adapter: node() }).use(corsPlugin).use(healthRoute);
    const gcpTokenProvider = options?.config?.backendType === "GCP" ? new GcpAccessTokenProviderService() : null;

    if (options?.tokenVerifier) {
        app.use(wellKnownRoute(options.tokenVerifier));
    }

    if (options?.tokenVerifier && options.config) {
        const config = options.config;
        // FhirBackendService 只在真的有人要用時才建立：AuditEventService 與 list checker。
        const fhirBackend =
            options.fhirBackend ??
            (options.auditEventService === undefined || config.accessChecker === "list"
                ? new FhirBackendService({
                      baseUrl: config.proxyTo,
                      ...(gcpTokenProvider ? { getBearerToken: () => gcpTokenProvider.getAccessToken() } : {}),
                  })
                : undefined);
        app.use(
            fhirRoute({
                config,
                tokenVerifier: options.tokenVerifier,
                launchContextProvider: options.launchContextProvider ?? defaultLaunchContextProvider,
                ...(fhirBackend ? { fhirBackend } : {}),
                allowedQueries:
                    options.allowedQueries ?? AllowedQueriesCheckerService.loadFromFile(config.allowedQueriesFile),
                accessCheckerRegistry: options.accessCheckerRegistry ?? createDefaultAccessCheckerRegistry(),
                patientFinder: options.patientFinder ?? PatientFinderService.getInstance(),
                httpFhirClient:
                    options.httpFhirClient ??
                    new HttpFhirClientService({
                        proxyTo: config.proxyTo,
                        backendType: config.backendType,
                        // GCP 轉發與後端查詢共用同一組 ADC；未提供時建構即失敗。
                        ...(gcpTokenProvider ? { getGcpAccessToken: () => gcpTokenProvider.getAccessToken() } : {}),
                    }),
                ...(options.auditEventService || !fhirBackend
                    ? {}
                    : { auditEventService: new AuditEventService(fhirBackend) }),
            }),
        );
    }

    return app;
};

export type App = ReturnType<typeof createApp>;
