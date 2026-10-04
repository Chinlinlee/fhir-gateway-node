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

/**
 * Launch lifecycle 事件（CONTEXT.md 的 **Launch AuditEvent**）的類別 system。
 *
 * `AuditEvent.type` 的 binding 是 **extensible**，FHIR 明講「需要時可定義自己的 code system」
 * （https://hl7.org/fhir/R4/auditevent.html 6.4.3.3）。launch 事件不是 REST 操作，用 dNAV 的
 * `rest` 描述它會讓稽核消費者把兩類事件混為一談，因此自訂一個 system：稽核消費者以
 * `type.system` 分流——`terminology.hl7.org` 的 audit-event-type 是 access AuditEvent，
 * 這裡是 Launch AuditEvent。URI 是本專案自用的 placeholder，醫院要換成自己的 namespace
 * 時只改這一處。
 */
const LAUNCH_AUDIT_EVENT_SYSTEM = "http://smart-fhir-gateway.example/CodeSystem/audit-event-type";
const LAUNCH_AUDIT_EVENT_TYPE = "launch";
const LAUNCH_CONTEXT_REGISTERED_SUBTYPE = "launch-context-registered";
const LAUNCH_CONTEXT_BOUND_SUBTYPE = "launch-context-bound";

/** operator 未設定 public base URL 時，稽核事件用來指認 gateway 本身的名稱。 */
const GATEWAY_DISPLAY_NAME = "SMART FHIR Gateway";

/**
 * EHR 註冊一份 launch context：context 已建立，尚未綁定到任何使用者。
 * Launch context 註冊——此時還沒有被授權的人，只有建立者與綁定的病人。
 */
export type LaunchContextRegistrationAuditInput = {
    phase: "registration";
    /** 這份 context 綁定的病人參考；list launch 指向 FHIR List。 */
    patientReference: string;
    /** gateway 自己的 public base URL，寫在 observer；operator 未設定時不寫，絕不從 Host header 推導。 */
    gatewayBaseUrl?: string;
};

/**
 * 綁定點：authorization flow 的 callback 把 launch context 綁到使用者與 SMART App。
 * Launch context 綁定——被授權的使用者、client 與病人在這一刻第一次同時在手。
 */
export type LaunchContextBindingAuditInput = {
    phase: "binding";
    /** 被綁定的病人參考；list launch 指向 FHIR List。 */
    patientReference: string;
    /** 被授權的使用者（JWT `sub`）。 */
    subject: string;
    /** 被授權的 SMART App client id；gateway 自己的 IdP client 不在這裡。 */
    clientId: string;
    gatewayBaseUrl: string;
    /** 簽出 subject 的 IdP（JWT `iss`）；與 subject 一起構成被授權使用者的識別碼。 */
    issuer?: string;
};

export type LaunchAuditEventInput = LaunchContextRegistrationAuditInput | LaunchContextBindingAuditInput;

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

/**
 * Launch lifecycle 事件的內容只放「誰授權了誰看哪位病人」：建立者、被授權的使用者、
 * 被授權的 client 與綁定的病人參考。**不記 request body、不記整包資源**——這兩則事件是
 * PHI 授權軌跡，不是資料快照。
 *
 * action 沿用 FHIR 的 C（create）／U（update）：註冊建立了一份 context，綁定把同一份
 * context 由未綁定改成已綁定。
 */
function buildLaunchAuditEvent(input: LaunchAuditEventInput): fhir4.AuditEvent {
    const isBinding = input.phase === "binding";
    const agents: fhir4.AuditEventAgent[] = isBinding
        ? [
              {
                  requestor: false,
                  // 人；`who` 的型別（Practitioner／Application）已分出人與機器。
                  who: {
                      type: "Practitioner",
                      ...(input.issuer !== undefined
                          ? { identifier: { system: input.issuer, value: input.subject } }
                          : {}),
                  },
              },
              {
                  // 被授權的 SMART App。App 的 client id 只存在於這一次 authorize 記下的
                  // pending（access token 的 `azp` 是 gateway 自己），因此這裡是它唯一的出處。
                  requestor: true,
                  who: { type: "Application", display: input.clientId },
              },
          ]
        : [
              {
                  // 建立者是 EHR 服務帳號；內部認證憑證是共享密碼，不可寫進稽核事件，
                  // 因此建立者只記到角色。
                  requestor: true,
                  who: { type: "Application", display: "EHR" },
              },
          ];

    return {
        resourceType: "AuditEvent",
        type: { system: LAUNCH_AUDIT_EVENT_SYSTEM, code: LAUNCH_AUDIT_EVENT_TYPE },
        subtype: [
            {
                system: LAUNCH_AUDIT_EVENT_SYSTEM,
                code: isBinding ? LAUNCH_CONTEXT_BOUND_SUBTYPE : LAUNCH_CONTEXT_REGISTERED_SUBTYPE,
            },
        ],
        action: isBinding ? "U" : "C",
        recorded: new Date().toISOString(),
        outcome: "0",
        agent: agents,
        // observer 只放 operator 設定的 base URL：絕不從 request 的 Host 推導，那個 header
        // 由呼叫端控制。未設定 public base URL 的部署以產品名記錄 gateway 本身。
        source: { observer: { display: input.gatewayBaseUrl ?? GATEWAY_DISPLAY_NAME } },
        entity: [{ what: { reference: input.patientReference } }],
    };
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

    /**
     * Launch lifecycle 事件（CONTEXT.md 的 **Launch AuditEvent**）與 access 事件走同一個
     * backend、同一次 POST，**不開第二條管道**；兩類事件靠 `type` 的 system 分開。
     *
     * 不吃 `configuredActions`：`AUDIT_EVENT_ACTIONS_CONFIG` 篩的是「哪一種 FHIR 存取」，
     * launch 事件不是存取。要不要稽核由呼叫端決定。
     */
    async logLaunch(input: LaunchAuditEventInput): Promise<void> {
        await this.backend.postResource(buildLaunchAuditEvent(input));
    }
}
