import type { RequestMutation } from "../types/request-mutation";

function cloneQueryParams(queryParams: Record<string, string[]>): Record<string, string[]> {
    const cloned: Record<string, string[]> = {};
    for (const [key, values] of Object.entries(queryParams)) {
        cloned[key] = [...values];
    }
    return cloned;
}

/**
 * 套用 AccessDecision mutation；對齊 BearerAuthorizationInterceptor.mutateRequest。
 * Applies query param add/overwrite/remove before forwarding to upstream FHIR server.
 */
export function applyRequestMutation(
    queryParams: Record<string, string[]>,
    mutation: RequestMutation | null | undefined,
): Record<string, string[]> {
    if (!mutation) {
        return queryParams;
    }

    const hasAdditional =
        mutation.additionalQueryParams !== undefined && Object.keys(mutation.additionalQueryParams).length > 0;
    const hasDiscard = mutation.discardQueryParams !== undefined && mutation.discardQueryParams.length > 0;

    if (!hasAdditional && !hasDiscard) {
        return queryParams;
    }

    const result = cloneQueryParams(queryParams);

    for (const key of mutation.discardQueryParams ?? []) {
        delete result[key];
    }

    for (const [key, values] of Object.entries(mutation.additionalQueryParams ?? {})) {
        result[key] = [...values];
    }

    return result;
}
