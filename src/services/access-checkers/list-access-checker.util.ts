import type { AccessDecision } from "../../types/access-decision";
import { accessDecisionWithMutation, accessGranted, noOpAccessDecision } from "../../types/access-decision";
import type { FhirRequestDetails } from "../../types/fhir-request";
import type { HttpFhirClientLike } from "../../types/http-fhir-client";
import { isSameResourceType } from "../../utils/fhir.util";

type AccessGrantedAndUpdateListOptions = {
    patientListId: string;
    httpFhirClient: HttpFhirClientLike;
    existPutPatients: ReadonlySet<string>;
    expectedResourceType: "Patient" | "Bundle";
};

/** POST Patient / Bundle 新建 Patient 後 postProcess 更新 access List；對齊 Java AccessGrantedAndUpdateList。 */
export function accessGrantedAndUpdateList(options: AccessGrantedAndUpdateListOptions): AccessDecision {
    const { patientListId, httpFhirClient, existPutPatients, expectedResourceType } = options;

    return {
        canAccess: () => true,
        getRequestMutation: () => null,
        postProcess: (_request, response) => {
            if (response.status < 200 || response.status >= 300) {
                return response.body;
            }

            let parsed: unknown;
            try {
                parsed = JSON.parse(response.body);
            } catch {
                return response.body;
            }

            if (!parsed || typeof parsed !== "object") {
                return response.body;
            }

            const resource = parsed as fhir4.Resource;
            if (!isSameResourceType(resource.resourceType, expectedResourceType)) {
                return response.body;
            }

            if (isSameResourceType(resource.resourceType, "Patient")) {
                const patientId = resource.id;
                if (patientId) {
                    addPatientToList(patientListId, patientId, httpFhirClient);
                }
                return response.body;
            }

            const bundle = resource as fhir4.Bundle;
            const patientIdsInResponse = new Set<string>();
            for (const entry of bundle.entry ?? []) {
                const location = entry.response?.location;
                if (typeof location !== "string") {
                    continue;
                }
                const patientId = parsePatientIdFromLocation(location);
                if (patientId) {
                    patientIdsInResponse.add(patientId);
                }
            }

            for (const patientId of patientIdsInResponse) {
                if (!existPutPatients.has(patientId)) {
                    addPatientToList(patientListId, patientId, httpFhirClient);
                }
            }

            return response.body;
        },
        getUserWho: () => null,
    };
}

export function accessGrantedAndUpdateListForPatient(
    patientListId: string,
    httpFhirClient: HttpFhirClientLike,
): AccessDecision {
    return accessGrantedAndUpdateList({
        patientListId,
        httpFhirClient,
        existPutPatients: new Set(),
        expectedResourceType: "Patient",
    });
}

export function accessGrantedAndUpdateListForBundle(
    patientListId: string,
    httpFhirClient: HttpFhirClientLike,
    existPutPatients: ReadonlySet<string>,
): AccessDecision {
    return accessGrantedAndUpdateList({
        patientListId,
        httpFhirClient,
        existPutPatients,
        expectedResourceType: "Bundle",
    });
}

function parsePatientIdFromLocation(location: string): string | null {
    const match = /Patient\/([A-Za-z0-9.-]{1,64})/.exec(location);
    return match?.[1] ?? null;
}

function addPatientToList(patientListId: string, newPatientId: string, httpFhirClient: HttpFhirClientLike): void {
    const jsonPatch = JSON.stringify([
        {
            op: "add",
            path: "/entry/-",
            value: {
                item: {
                    reference: `Patient/${newPatientId}`,
                },
            },
        },
    ]);
    httpFhirClient.patchResource(`List/${encodeURIComponent(patientListId)}`, jsonPatch);
}

export function buildListSearchPath(patientListId: string, itemsParam: string): string {
    return `/List?_id=${encodeURIComponent(patientListId)}&_elements=id&${itemsParam}`;
}

export function buildPatientExistenceSearchPath(patientId: string): string {
    return `/Patient?_id=${encodeURIComponent(patientId)}&_elements=id`;
}

export function queryBuilder(values: Iterable<string>, prefix: string, delimiter: string): string {
    return [...values]
        .filter((value) => value.length > 0)
        .sort()
        .map((value) => `${prefix}${encodeURIComponent(value)}`)
        .join(delimiter);
}

/** OR 查詢：item=Patient%2Fid1%2CPatient%2Fid2（id 排序以穩定 mock 比對） */
export function buildAnyPatientItemParam(patientIds: ReadonlySet<string>): string {
    const patientParam = [...patientIds]
        .filter((id) => id.length > 0)
        .sort()
        .map((id) => encodeURIComponent(`Patient/${id}`))
        .join("%2C");
    return `item=${patientParam}`;
}

function normalizeSearchPath(path: string): string {
    const queryIndex = path.indexOf("?");
    if (queryIndex < 0) {
        return path;
    }
    const basePath = path.slice(0, queryIndex);
    const segments = path
        .slice(queryIndex + 1)
        .split("&")
        .filter((segment) => segment.length > 0)
        .sort();
    return `${basePath}?${segments.join("&")}`;
}

export function normalizeFhirClientPath(path: string): string {
    return normalizeSearchPath(path);
}

export function listIncludesItems(
    httpFhirClient: HttpFhirClientLike,
    patientListId: string,
    itemsParam: string,
): boolean {
    if (!itemsParam.startsWith("item=") || itemsParam === "item=") {
        return false;
    }

    try {
        const bundle = httpFhirClient.getResource(buildListSearchPath(patientListId, itemsParam));
        return bundle.total === 1;
    } catch {
        return false;
    }
}

export function serverListIncludesAnyPatient(
    httpFhirClient: HttpFhirClientLike,
    patientListId: string,
    patientIds: ReadonlySet<string>,
): boolean {
    if (patientIds.size === 0) {
        return false;
    }
    return listIncludesItems(httpFhirClient, patientListId, buildAnyPatientItemParam(patientIds));
}

export function serverListIncludesAllPatients(
    httpFhirClient: HttpFhirClientLike,
    patientListId: string,
    patientQueries: ReadonlySet<string>,
): boolean {
    if (patientQueries.size === 0) {
        return false;
    }
    const patientParam = queryBuilder(patientQueries, "item=", "&");
    return listIncludesItems(httpFhirClient, patientListId, patientParam);
}

export function patientsExist(httpFhirClient: HttpFhirClientLike, patientId: string): boolean {
    try {
        const bundle = httpFhirClient.getResource(buildPatientExistenceSearchPath(patientId));
        return (bundle.total ?? 0) > 0;
    } catch {
        return false;
    }
}

export function toPatientReferenceQueries(patientIds: ReadonlySet<string>): Set<string> {
    const queries = new Set<string>();
    for (const patientId of patientIds) {
        queries.add(`Patient/${patientId}`);
    }
    return queries;
}

export function parseRequestBundle(request: FhirRequestDetails): fhir4.Bundle | null {
    if (!request.requestBody) {
        return null;
    }
    const parsed = JSON.parse(request.requestBody) as fhir4.Bundle;
    return parsed;
}

export function deniedAccessDecision(): AccessDecision {
    return noOpAccessDecision(false);
}

export function grantedAccessDecision(granted: boolean): AccessDecision {
    return noOpAccessDecision(granted);
}

export { accessDecisionWithMutation, accessGranted };
