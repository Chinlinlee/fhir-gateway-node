import type { AccessDecision } from "./access-decision";
import type { FhirRequestDetails } from "./fhir-request";
import type { VerifiedJwt } from "./verified-jwt";

export type { RequestMutation } from "./request-mutation";
export type { AccessDecision, AuditUserWho, FhirProxyResponse } from "./access-decision";

/** PatientFinder 介面切片，避免 types ↔ services 循環依賴。 */
export type PatientFinderLike = {
    findPatientsFromParams: (requestPath: string, queryParams: Record<string, string[]>) => Set<string>;
};

/**
 * 建立 AccessChecker 所需依賴（HttpFhirClient 等於 Phase 7 補上）。
 * Dependencies for creating an AccessChecker (HttpFhirClient etc. in Phase 7).
 */
export type AccessCheckerCreateContext = {
    jwt: VerifiedJwt;
    patientFinder: PatientFinderLike;
};

/** 每請求一個實例；對齊 Java AccessChecker。 */
export type AccessChecker = {
    checkAccess: (request: FhirRequestDetails) => AccessDecision;
};

/** thread-safe；對齊 Java AccessCheckerFactory。 */
export type AccessCheckerFactory = {
    create: (context: AccessCheckerCreateContext) => AccessChecker;
};
