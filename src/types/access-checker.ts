import type { AccessDecision } from "./access-decision";
import type { BundlePatients } from "./bundle-patients";
import type { FhirBundle } from "./fhir-bundle";
import type { FhirRequestDetails } from "./fhir-request";
import type { HttpFhirClientLike } from "./http-fhir-client";
import type { VerifiedJwt } from "./verified-jwt";

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
 * 建立 AccessChecker 所需依賴（HttpFhirClient 等於 Phase 7 補上）。
 * Dependencies for creating an AccessChecker (HttpFhirClient etc. in Phase 7).
 */
export type AccessCheckerCreateContext = {
    jwt: VerifiedJwt;
    patientFinder: PatientFinderLike;
    httpFhirClient?: HttpFhirClientLike;
};

/** 每請求一個實例；對齊 Java AccessChecker。 */
export type AccessChecker = {
    checkAccess: (request: FhirRequestDetails) => AccessDecision;
};

/** thread-safe；對齊 Java AccessCheckerFactory。 */
export type AccessCheckerFactory = {
    create: (context: AccessCheckerCreateContext) => AccessChecker;
};
