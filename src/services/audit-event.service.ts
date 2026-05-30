/// <reference types="fhir" />

import type { JWTPayload } from "jose";

import type { AuditUserWho } from "../types/access-decision";
import type { FhirRequestDetails, FhirRequestMethod } from "../types/fhir-request";

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

function extractResourceReference(requestPath: string, contentLocation: string | null): string | null {
    if (contentLocation) {
        const normalized = contentLocation.replace(/^https?:\/\/[^/]+\/?/, "");
        const fhirIndex = normalized.indexOf("/fhir/");
        if (fhirIndex >= 0) {
            return normalized.slice(fhirIndex + "/fhir/".length);
        }
        return normalized.replace(/^\/+/, "");
    }
    const path = requestPath.replace(/^\/+/, "");
    return path.length > 0 ? path : null;
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

        console.log(JSON.stringify(auditEvent, null, 2));

        await this.backend.postResource(auditEvent);
    }
}
