/// <reference types="fhir" />

import type { JWTPayload } from "jose";

import type { AuditUserWho } from "../types/access-decision";
import type { FhirRequestDetails, FhirRequestMethod } from "../types/fhir-request";
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
    jwtPayload: JWTPayload;
    gatewayBaseUrl: string;
    configuredActions: ReadonlyArray<string>;
};

const AUDIT_EVENT_TYPE_SYSTEM = "http://terminology.hl7.org/CodeSystem/audit-event-type";
const AUDIT_EVENT_REST_TYPE = "rest";
const AUDIT_REST_INTERACTION_SYSTEM = "http://hl7.org/fhir/restful-interaction";

function toRestInteraction(method: FhirRequestMethod): string {
    switch (method) {
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

function toAuditAction(method: FhirRequestMethod, responseStatus: number): "C" | "R" | "U" | "D" | "E" | null {
    if (responseStatus >= 400) {
        return "E";
    }
    switch (method) {
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

function claimAsString(payload: JWTPayload, claim: string): string | undefined {
    const value = payload[claim];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

export class AuditEventService {
    private readonly backend: AuditEventBackend;

    constructor(backend: AuditEventBackend) {
        this.backend = backend;
    }

    async log(input: AuditEventInput): Promise<void> {
        const action = toAuditAction(input.request.requestType, input.responseStatus);
        if (!action || !input.configuredActions.includes(action)) {
            return;
        }

        const resourceReference = extractResourceReference(
            input.request.requestPath,
            input.responseHeaders.get("content-location"),
            input.responseBody,
        );

        const azp = claimAsString(input.jwtPayload, "azp");
        const jti = claimAsString(input.jwtPayload, "jti");
        const sub = claimAsString(input.jwtPayload, "sub");

        const auditEvent: fhir4.AuditEvent = {
            resourceType: "AuditEvent",
            type: {
                system: AUDIT_EVENT_TYPE_SYSTEM,
                code: AUDIT_EVENT_REST_TYPE,
            },
            subtype: [
                {
                    system: AUDIT_REST_INTERACTION_SYSTEM,
                    code: toRestInteraction(input.request.requestType),
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
            ...(resourceReference
                ? {
                      entity: [
                          {
                              what: {
                                  reference: resourceReference,
                              },
                          },
                      ],
                  }
                : {}),
        };

        await this.backend.postResource(auditEvent);
    }
}
