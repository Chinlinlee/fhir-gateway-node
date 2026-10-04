import type { AccessDecision } from "./access-decision";
import type { BundlePatients } from "./bundle-patients";
import type { FhirBundle } from "./fhir-bundle";
import type { FhirRequestDetails } from "./fhir-request";
import type { AsyncFhirClientLike } from "./http-fhir-client";
import type { LaunchContext } from "./launch-context";

export type { AccessDecision, AuditUserWho, FhirProxyResponse } from "./access-decision";
export type { RequestMutation } from "./request-mutation";

/** PatientFinder 介面切片，避免 types ↔ services 循環依賴。 */
export type PatientFinderLike = {
    findPatientsFromParams: (requestPath: string, queryParams: Record<string, string[]>) => Set<string>;
    findPatientsForAccessCheck: (requestPath: string, queryParams: Record<string, string[]>) => Set<string>;
    findPatientsInResource: (requestPath: string, requestBody: string) => Set<string>;
    findPatientsInPatch: (requestBody: string, resourceName: string) => Set<string>;
    findPatientsInBundle: (bundle: FhirBundle, options?: { strict?: boolean }) => BundlePatients;
    isPatientCompartmentResource: (resourceName: string) => boolean;
};

/**
 * 建立 AccessChecker 所需依賴。
 * Dependencies for creating an AccessChecker.
 * Access checkers read the IdP-neutral LaunchContext, never raw JWT claims.
 */
export type AccessCheckerCreateContext = {
    launch: LaunchContext;
    patientFinder: PatientFinderLike;
    /**
     * 非同步 FHIR client。List checker 在 `prepare` 階段用它預載同步 client 所需的查詢結果。
     * Asynchronous FHIR client; list mode resolves its membership queries through it.
     */
    fhirBackend?: AsyncFhirClientLike;
};

/** 每請求一個實例；對齊 Java AccessChecker。 */
export type AccessChecker = {
    /**
     * 選用：同步 checkAccess 之前的非同步解析（例：預載 FHIR List membership）。
     * Optional asynchronous resolution awaited by the proxy controller before checkAccess.
     */
    prepare?: (request: FhirRequestDetails) => Promise<void>;
    checkAccess: (request: FhirRequestDetails) => AccessDecision;
};

/** thread-safe；對齊 Java AccessCheckerFactory。 */
export type AccessCheckerFactory = {
    create: (context: AccessCheckerCreateContext) => AccessChecker;
};
