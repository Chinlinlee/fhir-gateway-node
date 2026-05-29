import type { FhirRequestDetails, FhirRequestMethod } from "../../src/types/fhir-request";

/** Build FhirRequestDetails for allow-list tests. */
export function buildFhirRequest(
    requestPath: string,
    queryParams: Record<string, string | string[]> = {},
    requestType: FhirRequestMethod = "GET",
): FhirRequestDetails {
    const normalized: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(queryParams)) {
        normalized[key] = Array.isArray(value) ? value : [value];
    }
    return { requestPath, requestType, queryParams: normalized };
}
