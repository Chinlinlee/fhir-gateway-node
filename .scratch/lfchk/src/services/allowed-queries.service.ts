import { readFileSync } from "node:fs";

import type { AccessDecision } from "../types/access-decision";
import { accessDenied, accessGranted } from "../types/access-decision";
import type { FhirRequestDetails } from "../types/fhir-request";
import type { AllowedQueriesConfig, AllowedQueryEntry } from "../validations/allowed-queries.schema";
import { AllowedQueriesConfigSchema, MATCHES_ANY_VALUE } from "../validations/allowed-queries.schema";

export class AllowedQueriesConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AllowedQueriesConfigError";
    }
}

/**
 * Query allow-list bypasses AccessChecker when matched (SPEC §6).
 */
export class AllowedQueriesCheckerService {
    private readonly config: AllowedQueriesConfig | null;

    private constructor(config: AllowedQueriesConfig | null) {
        this.config = config;
    }

    /** Disabled when ALLOWED_QUERIES_FILE unset. */
    static loadFromFile(configFile: string | undefined): AllowedQueriesCheckerService {
        const trimmed = configFile?.trim();
        if (!trimmed) {
            return new AllowedQueriesCheckerService(null);
        }

        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(trimmed, "utf8")) as unknown;
        } catch (error) {
            const message = error instanceof Error ? error.message : "IO error";
            throw new AllowedQueriesConfigError(`IO error while reading allow-list config file ${trimmed}: ${message}`);
        }

        const parsed = AllowedQueriesConfigSchema.safeParse(raw);
        if (!parsed.success) {
            // Align with Java Gson failure message
            throw new AllowedQueriesConfigError("A map with a single `entries` array expected!");
        }

        for (const entry of parsed.data.entries) {
            // path 欄位必須存在（允許空字串，對應根路徑）
            if (entry.path === undefined) {
                throw new AllowedQueriesConfigError("Allow-list entries should have a path.");
            }
        }

        return new AllowedQueriesCheckerService(parsed.data);
    }

    isEnabled(): boolean {
        return this.config !== null;
    }

    /**
     * For unauthenticated requests (checked before JWT).
     */
    checkUnAuthenticatedAccess(request: FhirRequestDetails): AccessDecision {
        if (this.config === null) {
            return accessDenied();
        }

        for (const entry of this.config.entries) {
            if (entry.allowUnauthenticatedRequests && this.requestMatches(request, entry)) {
                return accessGranted();
            }
        }

        return accessDenied();
    }

    /** After JWT validation — any matching entry grants access. */
    checkAccess(request: FhirRequestDetails): AccessDecision {
        if (this.config === null) {
            return accessDenied();
        }

        for (const entry of this.config.entries) {
            if (this.requestMatches(request, entry)) {
                return accessGranted();
            }
        }

        return accessDenied();
    }

    private requestMatches(request: FhirRequestDetails, entry: AllowedQueryEntry): boolean {
        if (!this.allowRequestPath(request.requestPath, entry.path)) {
            return false;
        }

        if (
            entry.requestType !== undefined &&
            entry.requestType.length > 0 &&
            request.requestType.toUpperCase() !== entry.requestType.toUpperCase()
        ) {
            return false;
        }

        const matchedQueryParamKeys = new Set<string>();

        for (const [expectedKey, expectedValue] of Object.entries(entry.queryParams)) {
            const actualValues = request.queryParams[expectedKey];

            if (actualValues === undefined) {
                if (entry.allParamsRequired) {
                    return false;
                }
                continue;
            }

            if (expectedValue !== MATCHES_ANY_VALUE) {
                // Multi-value params are not supported for explicit values
                if (actualValues.length !== 1) {
                    return false;
                }
                if (actualValues[0] !== expectedValue) {
                    return false;
                }
            }

            matchedQueryParamKeys.add(expectedKey);
        }

        const requestParamCount = Object.keys(request.queryParams).length;
        if (!entry.allowExtraParams && matchedQueryParamKeys.size !== requestParamCount) {
            return false;
        }

        return true;
    }

    private allowRequestPath(path: string, entryPath: string): boolean {
        if (path === entryPath) {
            return true;
        }

        const suffix = `/${MATCHES_ANY_VALUE}`;
        if (entryPath.endsWith(suffix)) {
            const basePath = entryPath.slice(0, -suffix.length);
            return path === basePath || path.startsWith(`${basePath}/`);
        }

        return false;
    }
}
