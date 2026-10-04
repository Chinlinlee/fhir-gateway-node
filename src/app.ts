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
     * Launch context store；省略時由 app 建立 in-memory 實作。測試與單機開發用同一條 pipeline。
     * Injectable launch context store; defaults to the in-memory implementation.
     */
    launchContextStore?: LaunchContextStore;
};

export const createApp = (options?: CreateAppOptions) => {
    const app = new Elysia({ adapter: node() }).use(corsPlugin).use(healthRoute);
    const config = options?.config;
    const gcpTokenProvider = config?.backendType === "GCP" ? new GcpAccessTokenProviderService() : null;

    // 內部註冊端點與代理的授權流程共用同一個 store：`authorize` 檢查的 launch id 必須就是
    // EHR 剛建立的那一份，綁定也必須寫進同一份。
    const launchContextStore = options?.launchContextStore ?? new InMemoryLaunchContextStore();

    // 稽核管道在建構時解析一次，launch lifecycle 與 FHIR 存取共用同一個 AuditEventService
    // （CONTEXT.md 的 Launch AuditEvent 與 Access AuditEvent 共用管道）。
    // `AUDIT_EVENT_ACTIONS_CONFIG` 仍是唯一的稽核開關：空值代表完全不稽核。
    const auditEnabled = config !== undefined && config.auditEventActions.length > 0;
    // FhirBackendService 只在真的有人要用時才建立：AuditEventService 與 list checker。
    const fhirBackend =
        options?.fhirBackend ??
        (config !== undefined && (options?.auditEventService === undefined || config.accessChecker === "list")
            ? new FhirBackendService({
                  baseUrl: config.proxyTo,
                  ...(gcpTokenProvider ? { getBearerToken: () => gcpTokenProvider.getAccessToken() } : {}),
              })
            : undefined);
    const auditEventService =
        options?.auditEventService ?? (auditEnabled && fhirBackend ? new AuditEventService(fhirBackend) : undefined);

    // 內部 launch context 端點的認證獨立於 patient-facing bearer token，因此它的註冊
    // 不依賴 tokenVerifier：EHR 服務帳號在 App 開啟前就該能註冊一次 launch。
    if (config?.internalLaunchApiEnabled === true && config.internalLaunchApiCredential) {
        app.use(
            internalLaunchRoute({
                credential: config.internalLaunchApiCredential,
                ttlSeconds: config.launchContextTtlSeconds ?? DEFAULT_LAUNCH_CONTEXT_TTL_SECONDS,
                store: launchContextStore,
                ...(auditEventService ? { auditEventService } : {}),
                ...(config.gatewayPublicBaseUrl !== undefined ? { gatewayBaseUrl: config.gatewayPublicBaseUrl } : {}),
            }),
        );
    }

    // 代理 authorization flow 只在 operator 同時給了 public base URL 與 IdP client 憑證時成立；
    // 缺任何一項就維持被動，SMART App 照舊直接對 IdP 走授權流程，SMART configuration 也原樣代理。
    const gatewayPublicBaseUrl = config?.gatewayPublicBaseUrl;
    const gatewayClientId = config?.gatewayClientId;
    const gatewayClientSecret = config?.gatewayClientSecret;
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
                ...(auditEventService ? { auditEventService } : {}),
            }),
        );
    }

    if (options?.tokenVerifier) {
        app.use(wellKnownRoute(options.tokenVerifier, proxiedAuthorization ? gatewayPublicBaseUrl : undefined));
    }

    if (options?.tokenVerifier && config) {
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
                ...(auditEventService ? { auditEventService } : {}),
            }),
        );
    }

    return app;
};

export type App = ReturnType<typeof createApp>;
