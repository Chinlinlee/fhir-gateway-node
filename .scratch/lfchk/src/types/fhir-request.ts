/** HTTP method for allow-list matching (case-insensitive). */
export type FhirRequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

/**
 * Minimal request view for AllowedQueriesChecker (no HTTP framework types).
 */
export type FhirRequestDetails = {
    requestPath: string;
    requestType: FhirRequestMethod;
    /** Query param name → one or more values (multi-value supported for ANY_VALUE). */
    queryParams: Record<string, string[]>;
    /** Raw JSON request body for POST/PUT/PATCH/Bundle；AccessChecker 解析用。 */
    requestBody?: string;
};
