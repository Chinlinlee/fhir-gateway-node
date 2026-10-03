import { AuthenticationError } from "../../errors/authentication.error";
import type { AccessChecker, AccessCheckerCreateContext, AccessCheckerFactory } from "../../types/access-checker";
import type { AccessDecision } from "../../types/access-decision";
import type { FhirBundleEntry } from "../../types/fhir-bundle";
import type { FhirRequestDetails } from "../../types/fhir-request";
import { getResourceIdOrNull, isSameResourceType, parseResourcePath } from "../../utils/fhir.util";
import { MergedSmartScopeChecker, resolveSmartScopePrincipal, SmartScopePermission } from "../smart-scope.service";
import { deniedAccessDecision, grantedAccessDecision, parseRequestBundle } from "./list-access-checker.util";

export class BasicAccessCheckerService implements AccessChecker {
    private readonly smartScopeChecker: MergedSmartScopeChecker;

    constructor(smartScopeChecker: MergedSmartScopeChecker) {
        this.smartScopeChecker = smartScopeChecker;
    }

    checkAccess(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (request.requestType === "POST" && !resourceName) {
            return this.processBundle(request);
        }

        switch (request.requestType) {
            case "GET":
                return this.processGet(request);
            case "POST":
                return this.processPost(request);
            case "PUT":
            case "PATCH":
                return this.processUpdate(request);
            case "DELETE":
                return this.processDelete(request);
            default:
                return deniedAccessDecision();
        }
    }

    private processGet(request: FhirRequestDetails): AccessDecision {
        const { resourceName, resourceId } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (resourceId) {
            return grantedAccessDecision(
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.READ),
            );
        }

        return grantedAccessDecision(
            this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.SEARCH),
        );
    }

    private processPost(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            return deniedAccessDecision();
        }

        if (!request.requestBody) {
            return deniedAccessDecision();
        }

        return grantedAccessDecision(
            this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.CREATE),
        );
    }

    private processUpdate(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            const patientId = getResourceIdOrNull(request.requestPath);
            if (!patientId) {
                return deniedAccessDecision();
            }
            return grantedAccessDecision(this.smartScopeChecker.hasPermission("Patient", SmartScopePermission.UPDATE));
        }

        const updateMethod = request.requestType;
        if (updateMethod !== "PUT" && updateMethod !== "PATCH") {
            return deniedAccessDecision();
        }

        if (!request.requestBody) {
            return deniedAccessDecision();
        }

        return grantedAccessDecision(
            this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.UPDATE),
        );
    }

    private processDelete(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            return deniedAccessDecision();
        }

        return grantedAccessDecision(
            this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.DELETE),
        );
    }

    private processBundle(request: FhirRequestDetails): AccessDecision {
        const bundle = parseRequestBundle(request);
        if (!bundle) {
            return deniedAccessDecision();
        }

        for (const entry of bundle.entry ?? []) {
            if (!this.doesBundleElementHavePermission(entry)) {
                return deniedAccessDecision();
            }
        }
        return grantedAccessDecision(true);
    }

    private doesBundleElementHavePermission(entry: FhirBundleEntry): boolean {
        const bundleEntryRequest = entry.request;
        if (!bundleEntryRequest?.method) {
            return false;
        }

        switch (bundleEntryRequest.method) {
            case "GET": {
                const url = bundleEntryRequest.url;
                if (!url) {
                    return false;
                }
                return this.doesReferenceUrlHavePermission(url, SmartScopePermission.READ);
            }
            case "POST": {
                const resourceType = entry.resource?.resourceType;
                if (!resourceType) {
                    return false;
                }
                return this.smartScopeChecker.hasPermission(resourceType, SmartScopePermission.CREATE);
            }
            case "PUT": {
                const url = bundleEntryRequest.url;
                if (!url) {
                    return false;
                }
                return this.doesReferenceUrlHavePermission(url, SmartScopePermission.UPDATE);
            }
            case "PATCH": {
                const patchUrl = bundleEntryRequest.url;
                if (!patchUrl) {
                    return false;
                }
                return this.doesReferenceUrlHavePermission(patchUrl, SmartScopePermission.UPDATE);
            }
            case "DELETE": {
                const url = bundleEntryRequest.url;
                if (!url) {
                    return false;
                }
                return this.doesReferenceUrlHavePermission(url, SmartScopePermission.DELETE);
            }
            default:
                return false;
        }
    }

    private doesReferenceUrlHavePermission(url: string, permission: SmartScopePermission): boolean {
        const parsed = new URL(url, "http://localhost");
        const pathParts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        const resourceType = pathParts[0];
        if (!resourceType) {
            return this.smartScopeChecker.hasPermission(url, permission);
        }
        return this.smartScopeChecker.hasPermission(resourceType, permission);
    }
}

export const basicAccessCheckerFactory: AccessCheckerFactory = {
    create(context: AccessCheckerCreateContext): AccessChecker {
        const scopes = context.launch.scopes;
        if (!resolveSmartScopePrincipal(scopes)) {
            throw new AuthenticationError("No SMART FHIR scopes found in launch context");
        }

        return new BasicAccessCheckerService(new MergedSmartScopeChecker(scopes));
    },
};
