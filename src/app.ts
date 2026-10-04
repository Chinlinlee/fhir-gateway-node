import { node } from "@elysia/node";
import { Elysia } from "elysia";

import type { GatewayConfig } from "./configs/env.schema";
import { DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS } from "./constants/config";
import { corsPlugin } from "./middlewares/cors";
import { fhirRoute } from "./routes/fhir.route";
import { healthRoute } from "./routes/health.route";
import { internalLaunchRoute } from "./routes/internal-launch.route";
import { smartRoute } from "./routes/smart.route";
import { wellKnownRoute } from "./routes/well-known.route";
import type { AccessCheckerRegistryService } from "./services/access-checker-registry.service";
import { createDefaultAccessCheckerRegistry } from "./services/access-checker-registry.service";
import { AllowedQueriesCheckerService } from "./services/allowed-queries.service";
import { AuditEventService } from "./services/audit-event.service";
import { FhirBackendService } from "./services/fhir-backend.service";
import { GcpAccessTokenProviderService } from "./services/gcp-access-token-provider.service";
import { HttpFhirClientService } from "./services/http-fhir-client.service";
import { DefaultLaunchContextProvider } from "./services/launch-context.service";
import { InMemoryLaunchContextStore } from "./services/launch-context-store.service";
import { PatientFinderService } from "./services/patient-finder.service";
import { SmartAuthorizationSessions } from "./services/smart-authorization-sessions.service";
import type { TokenVerifierService } from "./services/token-verifier.service";
import type { LaunchContextProvider } from "./types/launch-context";
import type { LaunchContextStore } from "./types/launch-context-store";

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
    /**
     * Launch context store。
     *
     * 省略時建立 in-memory 實作：**測試與單機開發用的預設值，不適合正式環境**（重啟會失去
     * 綁定、多個 instance 互相看不見）。正式部署由 `createLaunchContextStore(config)`
     * 依 `LAUNCH_CONTEXT_STORE` 建立並注入。
     * Defaults to the in-memory implementation, which is not suitable for production.
     */
    launchContextStore?: LaunchContextStore;
};

export const createApp = (options?: CreateAppOptions) => {
    const app = new Elysia({ adapter: node() }).use(corsPlugin).use(healthRoute);
    const gcpTokenProvider = options?.config?.backendType === "GCP" ? new GcpAccessTokenProviderService() : null;

    // 內部註冊端點與代理的授權流程共用同一個 store：`authorize` 檢查的 launch id 必須就是
    // EHR 剛建立的那一份，綁定也必須寫進同一份。
    const launchContextStore = options?.launchContextStore ?? new InMemoryLaunchContextStore();

    // 內部 launch context 端點的認證獨立於 patient-facing bearer token，因此它的註冊
    // 不依賴 tokenVerifier：EHR 服務帳號在 App 開啟前就該能註冊一次 launch。
    if (options?.config?.internalLaunchApiEnabled === true && options.config.internalLaunchApiCredential) {
        app.use(
            internalLaunchRoute({
                credential: options.config.internalLaunchApiCredential,
                ttlSeconds: options.config.launchContextTtlSeconds ?? DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS,
                store: launchContextStore,
            }),
        );
    }

    // 代理 authorization flow 只在 operator 同時給了 public base URL 與 IdP client 憑證時成立；
    // 缺任何一項就維持被動，SMART App 照舊直接對 IdP 走授權流程，SMART configuration 也原樣代理。
    const gatewayPublicBaseUrl = options?.config?.gatewayPublicBaseUrl;
    const gatewayClientId = options?.config?.gatewayClientId;
    const gatewayClientSecret = options?.config?.gatewayClientSecret;
    const proxiedAuthorization =
        options?.tokenVerifier !== undefined &&
        gatewayPublicBaseUrl !== undefined &&
        gatewayClientId !== undefined &&
        gatewayClientSecret !== undefined;

    if (proxiedAuthorization && options.tokenVerifier) {
        app.use(
            smartRoute({
                publicBaseUrl: gatewayPublicBaseUrl,
                idpClientId: gatewayClientId,
                idpClientSecret: gatewayClientSecret,
                store: launchContextStore,
                sessions: new SmartAuthorizationSessions(),
                tokenVerifier: options.tokenVerifier,
            }),
        );
    }

    if (options?.tokenVerifier) {
        app.use(wellKnownRoute(options.tokenVerifier, proxiedAuthorization ? gatewayPublicBaseUrl : undefined));
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
                launchContextProvider:
                    options.launchContextProvider ?? new DefaultLaunchContextProvider(launchContextStore),
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
