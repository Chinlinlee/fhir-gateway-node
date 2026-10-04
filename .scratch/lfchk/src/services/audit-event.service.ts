/// <reference types="fhir" />

import type { AuditUserWho } from "../types/access-decision";
import type { FhirRequestDetails } from "../types/fhir-request";
import type { LaunchAgent } from "../types/launch-context";
import { isValidFhirId, isValidFhirResourceType } from "../utils/fhir.util";

type AuditEventBackend = {
    postResource: (resource: fhir4.Resource) => Promise<fhir4.Resource>;
};

export type AuditEventInput = {
    request: FhirRequestDetails;
    responseStatus: number;
    responseBody: string;
    responseHeaders: Headers;
    userWho: AuditUserWho;
    agent: LaunchAgent;
    gatewayBaseUrl: string;
    configuredActions: ReadonlyArray<string>;
};

const AUDIT_EVENT_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/audit-event-type";
const AUDIT_EVENT_REST_TYPE = "rest";
const AUDIT_REST_INTERACTION_SYSTEM = "http://hl7.org/fhir/restful-interaction";

function isSearchTypeRequest(request: FhirRequestDetails): boolean {
    const normalizedPath = request.requestPath.replace(/^\/+/, "").replace(/\/+$/, "");
    const segments = normalizedPath.split("/").filter((segment) => segment.length > 0);
    const [resourceType, operation] = segments;
    if (!resourceType) {
        return false;
    }

    if (request.requestType === "POST") {
        return segments.length === 2 && operation === "_search" && isValidFhirResourceType(resourceType);
    }

    if (request.requestType !== "GET") {
        return false;
    }

    return segments.length === 1 && isValidFhirResourceType(resourceType);
}

function toRestInteraction(request: FhirRequestDetails): string {
    if (isSearchTypeRequest(request)) {
        return "search-type";
    }

    switch (request.requestType) {
        case "GET":
            return "read";
        case "POST":
            return "create";
        case "PUT":
        case "PATCH":
            return "update";
        case "DELETE":
            return "delete";
        default:
            return "execute";
    }
}

function toAuditAction(request: FhirRequestDetails, responseStatus: number): "C" | "R" | "U" | "D" | "E" | null {
    if (responseStatus >= 400) {
        return "E";
    }

    if (isSearchTypeRequest(request)) {
        return "E";
    }

    switch (request.requestType) {
        case "GET":
            return "R";
        case "POST":
            return "C";
        case "PUT":
        case "PATCH":
            return "U";
        case "DELETE":
            return "D";
        default:
            return null;
    }
}

function toValidResourceReference(pathSegment: string): string | null {
    const parts = pathSegment.split("/").filter((part) => part.length > 0);
    if (parts.length < 2) {
        return null;
    }

    const resourceType = parts[0];
    const resourceId = parts[1];
    if (!resourceType || !resourceId || !isValidFhirResourceType(resourceType) || !isValidFhirId(resourceId)) {
        return null;
    }

    if (parts.length >= 4 && parts[2] === "_history" && parts[3]) {
        return `${resourceType}/${resourceId}/_history/${parts[3]}`;
    }

    return `${resourceType}/${resourceId}`;
}

function parseReferenceFromContentLocation(contentLocation: string | null): string | null {
    if (!contentLocation) {
        return null;
    }

    const withoutHost = contentLocation.replace(/^https?:\/\/[^/]+/, "");
    const fhirPathMatch = /(?:^|\/)fhir\/(.+)$/.exec(withoutHost);
    const pathAfterFhir = fhirPathMatch?.[1] ?? withoutHost.replace(/^\/+/, "");
    return toValidResourceReference(pathAfterFhir);
}

function parseReferenceFromRequestPath(requestPath: string): string | null {
    const normalized = requestPath.replace(/^\/+/, "").replace(/\/+$/, "");
    return toValidResourceReference(normalized);
}

function parseReferenceFromResponseBody(responseBody: string): string | null {
    try {
        const parsed = JSON.parse(responseBody) as fhir4.Resource;
        if (
            parsed.resourceType &&
            parsed.id &&
            isValidFhirResourceType(parsed.resourceType) &&
            isValidFhirId(parsed.id)
        ) {
            return `${parsed.resourceType}/${parsed.id}`;
        }
    } catch {
        return null;
    }
    return null;
}

function extractResourceReference(
    requestPath: string,
    contentLocation: string | null,
    responseBody: string,
): string | null {
    return (
        parseReferenceFromContentLocation(contentLocation) ??
        parseReferenceFromRequestPath(requestPath) ??
        parseReferenceFromResponseBody(responseBody)
    );
}

function buildEntityQuery(queryParams: Record<string, string[]>): string | null {
    const query = Object.entries(queryParams)
        .flatMap(([key, values]) => values.map((value) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`))
        .join("&");
    if (!query) {
        return null;
    }
    return Buffer.from(`?${query}`, "utf8").toString("base64");
}

function buildAuditEntity(
    isSearch: boolean,
    isDeleteAction: boolean,
    entityQuery: string | null,
    resourceReference: string | null,
): fhir4.AuditEvent["entity"] | undefined {
    if (isSearch) {
        if (!entityQuery) {
            return undefined;
        }
        return [{ query: entityQuery }];
    }

    if (isDeleteAction) {
        return undefined;
    }

    if (!resourceReference) {
        return undefined;
    }
    return [
        {
            what: {
                reference: resourceReference,
            },
        },
    ];
}

function buildAgentWho(userWho: AuditUserWho): fhir4.Reference {
    const identifier = userWho.identifier
        ? {
              system: userWho.identifier.system,
              value: userWho.identifier.value,
          }
        : undefined;
    return {
        type: userWho.resourceType,
        ...(userWho.display ? { display: userWho.display } : {}),
        ...(identifier ? { identifier } : {}),
    };
}

function toAuditOutcome(status: number): "0" | "8" {
    return status >= 400 ? "8" : "0";
}

export class AuditEventService {
    private readonly backend: AuditEventBackend;

    constructor(backend: AuditEventBackend) {
        this.backend = backend;
    }

    async log(input: AuditEventInput): Promise<void> {
        const isSearch = isSearchTypeRequest(input.request);
        const action = toAuditAction(input.request, input.responseStatus);
        if (!action || !input.configuredActions.includes(action)) {
            return;
        }

        const resourceReference = extractResourceReference(
            input.request.requestPath,
            input.responseHeaders.get("content-location"),
            input.responseBody,
        );
        const isDeleteAction = action === "D";
        const entityQuery = isSearch ? buildEntityQuery(input.request.queryParams) : null;
        const auditEntity = buildAuditEntity(isSearch, isDeleteAction, entityQuery, resourceReference);

        const azp = input.agent.authorizedParty;
        const jti = input.agent.tokenId;
        const sub = input.agent.subject;

        const auditEvent: fhir4.AuditEvent = {
            resourceType: "AuditEvent",
            type: {
                system: AUDIT_EVENT_TYPE_SYSTEM,
                code: AUDIT_EVENT_REST_TYPE,
            },
            subtype: [
                {
                    system: AUDIT_REST_INTERACTION_SYSTEM,
                    code: toRestInteraction(input.request),
                },
            ],
            action,
            recorded: new Date().toISOString(),
            outcome: toAuditOutcome(input.responseStatus),
            agent: [
                {
                    requestor: true,
                    who: buildAgentWho(input.userWho),
                    ...(sub || azp || jti
                        ? {
                              extension: [
                                  ...(sub ? [{ url: "urn:ietf:params:oauth:token-sub", valueString: sub }] : []),
                                  ...(azp ? [{ url: "urn:ietf:params:oauth:token-azp", valueString: azp }] : []),
                                  ...(jti ? [{ url: "urn:ietf:params:oauth:token-jti", valueString: jti }] : []),
                              ],
                          }
                        : {}),
                },
            ],
            source: {
                observer: {
                    display: input.gatewayBaseUrl,
                },
            },
            ...(auditEntity ? { entity: auditEntity } : {}),
        };

        await this.backend.postResource(auditEvent);
    }
}
