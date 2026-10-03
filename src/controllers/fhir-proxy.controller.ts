import { promisify } from "node:util";
import { gzip } from "node:zlib";

import type { GatewayConfig } from "../configs/env.schema";
import { AuthenticationError } from "../errors/authentication.error";
import { InvalidRequestError } from "../errors/invalid-request.error";
import type { AccessCheckerRegistryService } from "../services/access-checker-registry.service";
import type { AllowedQueriesCheckerService } from "../services/allowed-queries.service";
import type { AuditEventService } from "../services/audit-event.service";
import type { HttpFhirClientService } from "../services/http-fhir-client.service";
import type { PatientFinderService } from "../services/patient-finder.service";
import type { TokenVerifierService } from "../services/token-verifier.service";
import { type AccessDecision, defaultUserWhoFromLaunch } from "../types/access-decision";
import type { FhirRequestDetails, FhirRequestMethod } from "../types/fhir-request";
import type { AsyncFhirClientLike } from "../types/http-fhir-client";
import type { LaunchContext, LaunchContextProvider } from "../types/launch-context";
import type { VerifiedJwt } from "../types/verified-jwt";
import { applyGzipResponseHeaders, decodeCompressedBody } from "../utils/compression.util";
import { parseResourcePath } from "../utils/fhir.util";
import { formatErrorMessage } from "../utils/format-error.util";
import { getPrimaryPatientSearchParam } from "../utils/patient-params.util";
import { applyRequestMutation } from "../utils/request-mutation.util";

type FhirProxyControllerDeps = {
    config: GatewayConfig;
    tokenVerifier: TokenVerifierService;
    httpFhirClient: HttpFhirClientService;
    launchContextProvider: LaunchContextProvider;
    allowedQueries: AllowedQueriesCheckerService;
    accessCheckerRegistry: AccessCheckerRegistryService;
    patientFinder: PatientFinderService;
    /** 非同步 FHIR client；list checker 於 prepare 階段用它查詢 backend。 */
    fhirBackend?: AsyncFhirClientLike;
    auditEventService?: AuditEventService;
};

const gzipAsync = promisify(gzip);

function parseQueryParams(url: URL): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    url.searchParams.forEach((value, key) => {
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(value);
    });
    return result;
}

function parseHeaders(headers: Headers): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    headers.forEach((value, key) => {
        result[key] = value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    });
    return result;
}

function normalizeRequestPath(relativePath: string): string {
    return relativePath.replace(/^\/+/, "").replace(/\/+$/, "");
}

function createOperationOutcome(status: number, code: "forbidden" | "login", diagnostics: string): Response {
    return Response.json(
        {
            resourceType: "OperationOutcome",
            issue: [
                {
                    severity: "error",
                    code,
                    diagnostics,
                },
            ],
        },
        { status },
    );
}

function shouldReturnGzip(acceptEncodingHeader: string | null): boolean {
    return acceptEncodingHeader?.toLowerCase().includes("gzip") ?? false;
}

function replaceProxyBaseUrl(content: string, proxyTo: string, gatewayBaseUrl: string): string {
    return content.split(proxyTo).join(gatewayBaseUrl);
}

function enrichCapabilityStatementSecurity(rawBody: string): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody) as unknown;
    } catch {
        return rawBody;
    }

    if (!parsed || typeof parsed !== "object") {
        return rawBody;
    }
    const capability = parsed as {
        resourceType?: string;
        rest?: Array<{ security?: Record<string, unknown> }>;
    };
    if (capability.resourceType !== "CapabilityStatement") {
        return rawBody;
    }
    if (!Array.isArray(capability.rest) || capability.rest.length === 0) {
        capability.rest = [{}];
    }
    const firstRest = capability.rest[0] ?? {};
    firstRest.security = {
        ...(firstRest.security ?? {}),
        cors: true,
        service: [{ coding: [{ code: "OAuth" }] }],
    };
    capability.rest[0] = firstRest;
    return JSON.stringify(capability);
}

/**
 * patient mode 的 read 未帶 patient 搜尋參數時，依 launch context 授權的 patient 補上。
 * 注入與 access checker 共用同一個 `LaunchContext.patientId`，兩者不可能對授權的 patient 不一致。
 */
function maybeInjectPatientParam(
    config: GatewayConfig,
    requestPath: string,
    requestType: FhirRequestMethod,
    queryParams: Record<string, string[]>,
    launch: LaunchContext,
): Record<string, string[]> {
    if (config.accessChecker !== "patient" || requestType !== "GET" || !launch.patientId) {
        return queryParams;
    }
    const { resourceName } = parseResourcePath(requestPath);
    if (!resourceName || resourceName === "Patient") {
        return queryParams;
    }
    const searchParam = getPrimaryPatientSearchParam(resourceName);
    if (!searchParam || queryParams[searchParam]) {
        return queryParams;
    }
    return {
        ...queryParams,
        [searchParam]: [`Patient/${launch.patientId}`],
    };
}

function buildRequestDetails(
    requestPath: string,
    requestType: FhirRequestMethod,
    queryParams: Record<string, string[]>,
    requestBody?: string,
): FhirRequestDetails {
    return {
        requestPath,
        requestType,
        queryParams,
        ...(requestBody !== undefined ? { requestBody } : {}),
    };
}

async function postProcessResponseBody(
    requestPath: string,
    responseBody: string,
    accessDecision: AccessDecision,
    requestDetails: FhirRequestDetails,
    responseStatus: number,
): Promise<string> {
    let body = responseBody;
    if (requestPath === "metadata") {
        body = enrichCapabilityStatementSecurity(body);
    }
    try {
        const postProcessed = await accessDecision.postProcess?.(requestDetails, {
            status: responseStatus,
            body,
        });
        if (typeof postProcessed === "string") {
            return postProcessed;
        }
    } catch (error) {
        // postProcess 失敗（例如把新建立的 Patient 加回 access List 的 PATCH 失敗）不回頭改寫回應：
        // 上游的寫入已經發生並回 2xx，改成錯誤會誘導 client 重試而製造重複資源。
        // 但授權狀態已與回應不一致，必須留下足以稽核的紀錄。
        console.error(
            `[fhir-proxy] postProcess failed for ${requestDetails.requestType} ${requestPath}: ${formatErrorMessage(error)}; the upstream response is returned unchanged but authorization state may have diverged`,
        );
        return body;
    }
    return body;
}

export abstract class FhirProxyController {
    static async handle(
        request: Request,
        relativePath: string,
        deps: FhirProxyControllerDeps,
        fhirPrefix: string,
    ): Promise<Response> {
        const url = new URL(request.url);
        const requestPath = normalizeRequestPath(relativePath);
        const method = request.method.toUpperCase() as FhirRequestMethod;
        const bodyBytes = new Uint8Array(await request.arrayBuffer());
        const requestBody = bodyBytes.length > 0 ? Buffer.from(bodyBytes).toString("utf8") : undefined;
        const sourceHeaders = parseHeaders(request.headers);
        let queryParams = parseQueryParams(url);

        let accessDecision: AccessDecision;
        let launch: LaunchContext | undefined;

        if (requestPath === "metadata") {
            accessDecision = {
                canAccess: () => true,
                getRequestMutation: () => null,
                postProcess: () => null,
                getUserWho: () => null,
            };
        } else {
            const preAuthRequest = buildRequestDetails(requestPath, method, queryParams, requestBody);
            const unauthDecision = deps.allowedQueries.checkUnAuthenticatedAccess(preAuthRequest);
            if (unauthDecision.canAccess()) {
                accessDecision = unauthDecision;
            } else {
                const authHeader = request.headers.get("authorization");
                if (!authHeader) {
                    console.error(`[fhir-proxy] 401 ${method} ${requestPath}: missing Authorization header`);
                    return createOperationOutcome(401, "login", "No Authorization header provided!");
                }

                let verifiedJwt: VerifiedJwt;
                try {
                    verifiedJwt = await deps.tokenVerifier.decodeAndVerifyBearerToken(authHeader);
                } catch (error) {
                    const diagnostics =
                        error instanceof AuthenticationError || error instanceof Error
                            ? error.message
                            : "JWT verification failed";
                    console.error(`[fhir-proxy] 401 ${method} ${requestPath}: ${diagnostics}`);
                    return createOperationOutcome(401, "login", diagnostics);
                }

                launch = deps.launchContextProvider.create(verifiedJwt);
                queryParams = maybeInjectPatientParam(deps.config, requestPath, method, queryParams, launch);

                const authenticatedRequest = buildRequestDetails(requestPath, method, queryParams, requestBody);
                const allowedQueriesDecision = deps.allowedQueries.checkAccess(authenticatedRequest);
                if (allowedQueriesDecision.canAccess()) {
                    accessDecision = allowedQueriesDecision;
                } else {
                    let checkerDecision: AccessDecision;
                    try {
                        const checker = deps.accessCheckerRegistry.create(deps.config.accessChecker, {
                            launch,
                            patientFinder: deps.patientFinder,
                            ...(deps.fhirBackend ? { fhirBackend: deps.fhirBackend } : {}),
                        });
                        await checker.prepare?.(authenticatedRequest);
                        checkerDecision = checker.checkAccess(authenticatedRequest);
                    } catch (error) {
                        if (error instanceof InvalidRequestError) {
                            console.error(`[fhir-proxy] 400 ${method} ${requestPath}: ${error.message}`);
                            return createOperationOutcome(400, "forbidden", error.message);
                        }
                        const diagnostics =
                            error instanceof AuthenticationError
                                ? error.message
                                : error instanceof Error
                                  ? error.message
                                  : "Access checker initialization failed";
                        console.error(`[fhir-proxy] 401 ${method} ${requestPath}: ${diagnostics}`);
                        return createOperationOutcome(401, "login", diagnostics);
                    }
                    if (!checkerDecision.canAccess()) {
                        console.error(
                            `[fhir-proxy] 403 ${method} ${requestPath}: access checker denied (ACCESS_CHECKER=${deps.config.accessChecker})`,
                        );
                        return createOperationOutcome(403, "forbidden", `User is not authorized to ${method} ${url}`);
                    }
                    accessDecision = checkerDecision;
                }
            }
        }

        const mutationRequest = buildRequestDetails(requestPath, method, queryParams, requestBody);
        const mutation = accessDecision.getRequestMutation?.(mutationRequest);
        const mutatedQueryParams = applyRequestMutation(queryParams, mutation);
        const forwarded = await deps.httpFhirClient.handleRequest({
            method,
            requestPath,
            queryParams: mutatedQueryParams,
            headers: sourceHeaders,
            body: bodyBytes,
        });

        const decodedBodyBytes = decodeCompressedBody(forwarded.bodyBytes, forwarded.headers.get("content-encoding"));
        const rawResponseBody = Buffer.from(decodedBodyBytes).toString("utf8");
        let responseBody = await postProcessResponseBody(
            requestPath,
            rawResponseBody,
            accessDecision,
            mutationRequest,
            forwarded.status,
        );
        const gatewayBaseUrl = `${url.origin}${fhirPrefix}`;
        responseBody = replaceProxyBaseUrl(responseBody, deps.config.proxyTo, gatewayBaseUrl);

        const responseHeaders = deps.httpFhirClient.responseHeadersToKeep(forwarded.headers);
        if (!responseHeaders.has("content-type")) {
            responseHeaders.set("content-type", "application/json; charset=UTF-8");
        }

        const auditUserWho =
            accessDecision.getUserWho?.(mutationRequest) ?? (launch ? defaultUserWhoFromLaunch(launch.agent) : null);
        if (deps.auditEventService && deps.config.auditEventActions.length > 0 && auditUserWho && launch) {
            try {
                await deps.auditEventService.log({
                    request: mutationRequest,
                    responseStatus: forwarded.status,
                    responseBody,
                    responseHeaders,
                    userWho: auditUserWho,
                    agent: launch.agent,
                    gatewayBaseUrl,
                    configuredActions: deps.config.auditEventActions,
                });
            } catch (error) {
                // Audit 失敗不應影響主流程 / Audit failure must not affect client response
                console.error(error);
            }
        }

        if (shouldReturnGzip(request.headers.get("accept-encoding"))) {
            const gzipBody = await gzipAsync(Buffer.from(responseBody, "utf8"));
            applyGzipResponseHeaders(responseHeaders, gzipBody.byteLength);
            return new Response(gzipBody, {
                status: forwarded.status,
                headers: responseHeaders,
            });
        }

        return new Response(responseBody, {
            status: forwarded.status,
            headers: responseHeaders,
        });
    }
}
