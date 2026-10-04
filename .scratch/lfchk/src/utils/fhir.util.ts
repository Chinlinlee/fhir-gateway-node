import { FHIR_R4_RESOURCE_TYPES } from "../constants/fhir-r4-resource-types";
import { InvalidRequestError } from "../errors/invalid-request.error";

/** HL7 FHIR id type pattern. / 對齊 FhirUtil.ID_PATTERN */
const ID_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;

export function isValidFhirId(id: string): boolean {
    return ID_PATTERN.test(id);
}

export function checkFhirIdOrFail(idPart: string): string {
    if (!isValidFhirId(idPart)) {
        throw new InvalidRequestError(`ID ${idPart} is invalid!`);
    }
    return idPart;
}

export function isSameResourceType(resourceType: string | null | undefined, expected: string): boolean {
    return resourceType === expected;
}

/** 對齊 Java FhirUtil.isValidFhirResourceType / HAPI ResourceType.fromCode。 */
export function isValidFhirResourceType(resourceType: string): boolean {
    return FHIR_R4_RESOURCE_TYPES.has(resourceType);
}

/** Parse `Patient/abc` or `abc` into patient id. */
export function parsePatientIdFromToken(token: string): string | null {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
        return null;
    }

    const patientUrlMatch = /Patient\/([A-Za-z0-9.-]{1,64})/.exec(trimmed);
    if (patientUrlMatch?.[1]) {
        return checkFhirIdOrFail(patientUrlMatch[1]);
    }

    if (!trimmed.includes("/") && isValidFhirId(trimmed)) {
        return trimmed;
    }

    return null;
}

export function parseDelimitedPatientIds(delimited: string): Set<string> {
    const ids = new Set<string>();
    for (const part of delimited.split(",")) {
        const patientId = parsePatientIdFromToken(part);
        if (patientId) {
            ids.add(patientId);
        }
    }
    return ids;
}

export type ParsedResourcePath = {
    resourceName: string | null;
    resourceId: string | null;
};

/** Parse FHIR request path e.g. `Observation/123` or `Patient`. */
export function getResourceIdOrNull(requestPath: string): string | null {
    return parseResourcePath(requestPath).resourceId;
}

export function parseResourcePath(requestPath: string): ParsedResourcePath {
    const normalized = requestPath.replace(/^\/+/, "").replace(/\/+$/, "");
    if (normalized.length === 0) {
        return { resourceName: null, resourceId: null };
    }

    const parts = normalized.split("/").filter((p) => p.length > 0);
    if (parts.length === 1) {
        return { resourceName: parts[0] ?? null, resourceId: null };
    }

    if (parts.length >= 2 && parts[2] === "_history") {
        return {
            resourceName: parts[0] ?? null,
            resourceId: parts[1] ? checkFhirIdOrFail(parts[1]) : null,
        };
    }

    return {
        resourceName: parts[0] ?? null,
        resourceId: parts[1] ? checkFhirIdOrFail(parts[1]) : null,
    };
}

/** Parse query string into param map (multi-value supported). */
export function parseQueryString(query: string): Record<string, string[]> {
    const params: Record<string, string[]> = {};
    if (!query) {
        return params;
    }

    const search = query.startsWith("?") ? query.slice(1) : query;
    for (const segment of search.split("&")) {
        if (!segment) {
            continue;
        }
        const eq = segment.indexOf("=");
        const key = decodeURIComponent(eq >= 0 ? segment.slice(0, eq) : segment);
        const value = decodeURIComponent(eq >= 0 ? segment.slice(eq + 1) : "");
        if (!params[key]) {
            params[key] = [];
        }
        params[key].push(value);
    }

    return params;
}
