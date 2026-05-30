import type {
    AccessChecker,
    AccessCheckerCreateContext,
    AccessCheckerFactory,
    PatientFinderLike,
} from "../../types/access-checker";
import type { AccessDecision } from "../../types/access-decision";
import type { FhirBundleEntry } from "../../types/fhir-bundle";
import type { FhirRequestDetails } from "../../types/fhir-request";
import { getResourceIdOrNull, isSameResourceType, parseResourcePath } from "../../utils/fhir.util";
import { getJwtClaimIdOrFail, getJwtClaimOrFail } from "../../utils/jwt-claim.util";
import {
    extractSmartFhirScopesFromTokens,
    SmartScopeChecker,
    SmartScopePermission,
    SmartScopePrincipal,
} from "../smart-scope.service";
import { deniedAccessDecision, grantedAccessDecision, parseRequestBundle } from "./list-access-checker.util";

export const PATIENT_CLAIM = "patient";
export const SCOPES_CLAIM = "scope";

export class PatientAccessCheckerService implements AccessChecker {
    private readonly authorizedPatientId: string;
    private readonly patientFinder: PatientFinderLike;
    private readonly smartScopeChecker: SmartScopeChecker;

    constructor(authorizedPatientId: string, patientFinder: PatientFinderLike, smartScopeChecker: SmartScopeChecker) {
        this.authorizedPatientId = authorizedPatientId;
        this.patientFinder = patientFinder;
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
            return this.processRead(request, resourceName);
        }

        return this.processSearch(request, resourceName);
    }

    private processPost(request: FhirRequestDetails): AccessDecision {
        return this.processCreate(request);
    }

    private validatePatientIds(patientIds: ReadonlySet<string>): boolean {
        return patientIds.size === 1 && patientIds.has(this.authorizedPatientId);
    }

    private processRead(request: FhirRequestDetails, resourceName: string): AccessDecision {
        const patientIds = isSameResourceType(resourceName, "Patient")
            ? this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams)
            : this.patientFinder.findPatientsFromParams(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) &&
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.READ),
        );
    }

    private processSearch(request: FhirRequestDetails, resourceName: string): AccessDecision {
        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) &&
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.SEARCH),
        );
    }

    private processCreate(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            return deniedAccessDecision();
        }

        const body = request.requestBody;
        if (!body) {
            return deniedAccessDecision();
        }

        const patientIds = this.patientFinder.findPatientsInResource(request.requestPath, body);
        return grantedAccessDecision(
            patientIds.has(this.authorizedPatientId) &&
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.CREATE),
        );
    }

    private processUpdate(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            return this.checkPatientAccessInUpdate(request);
        }

        const updateMethod = request.requestType;
        if (updateMethod !== "PUT" && updateMethod !== "PATCH") {
            return deniedAccessDecision();
        }

        return this.checkNonPatientAccessInUpdate(request, resourceName, updateMethod);
    }

    private processDelete(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        if (isSameResourceType(resourceName, "Patient")) {
            return deniedAccessDecision();
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) &&
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.DELETE),
        );
    }

    private checkNonPatientAccessInUpdate(
        request: FhirRequestDetails,
        resourceName: string,
        updateMethod: "PUT" | "PATCH",
    ): AccessDecision {
        const referencedPatientIds = this.patientFinder.findPatientsForAccessCheck(
            request.requestPath,
            request.queryParams,
        );
        if (!this.validatePatientIds(referencedPatientIds)) {
            return deniedAccessDecision();
        }

        let patientIds = new Set<string>();
        const body = request.requestBody;

        if (updateMethod === "PATCH") {
            if (!body) {
                return deniedAccessDecision();
            }
            patientIds = this.patientFinder.findPatientsInPatch(body, resourceName);
            if (patientIds.size === 0) {
                return grantedAccessDecision(true);
            }
        }

        if (updateMethod === "PUT") {
            if (!body) {
                return deniedAccessDecision();
            }
            patientIds = this.patientFinder.findPatientsInResource(request.requestPath, body);
        }

        return grantedAccessDecision(
            patientIds.has(this.authorizedPatientId) &&
                this.smartScopeChecker.hasPermission(resourceName, SmartScopePermission.UPDATE),
        );
    }

    private checkPatientAccessInUpdate(request: FhirRequestDetails): AccessDecision {
        const patientId = getResourceIdOrNull(request.requestPath);
        if (!patientId) {
            return deniedAccessDecision();
        }

        return grantedAccessDecision(
            this.authorizedPatientId === patientId &&
                this.smartScopeChecker.hasPermission("Patient", SmartScopePermission.UPDATE),
        );
    }

    private processBundle(request: FhirRequestDetails): AccessDecision {
        const bundle = parseRequestBundle(request);
        if (!bundle) {
            return deniedAccessDecision();
        }

        const patientsInBundle = this.patientFinder.findPatientsInBundle(bundle, { strict: true });

        if (patientsInBundle.patientsToCreate || patientsInBundle.deletedPatients.size > 0) {
            return deniedAccessDecision();
        }

        if (
            patientsInBundle.updatedPatients.size > 0 &&
            !(
                patientsInBundle.updatedPatients.size === 1 &&
                patientsInBundle.updatedPatients.has(this.authorizedPatientId)
            )
        ) {
            return deniedAccessDecision();
        }

        for (const refSet of patientsInBundle.referencedPatients) {
            if (!refSet.has(this.authorizedPatientId)) {
                return deniedAccessDecision();
            }
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
                    // 對齊 Java PATCH→DELETE fallthrough：url 為空時最終拒絕
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
        if (pathParts.length >= 2) {
            return this.smartScopeChecker.hasPermission(resourceType, permission);
        }
        return this.smartScopeChecker.hasPermission(resourceType, permission);
    }
}

function createSmartScopeCheckerFromJwt(context: AccessCheckerCreateContext): SmartScopeChecker {
    const scopesClaim = getJwtClaimOrFail(context.jwt.payload, SCOPES_CLAIM);
    const scopes = extractSmartFhirScopesFromTokens(scopesClaim.split(/\s+/));
    return new SmartScopeChecker(scopes, SmartScopePrincipal.PATIENT);
}

export const patientAccessCheckerFactory: AccessCheckerFactory = {
    create(context: AccessCheckerCreateContext): AccessChecker {
        const authorizedPatientId = getJwtClaimIdOrFail(context.jwt.payload, PATIENT_CLAIM);
        const smartScopeChecker = createSmartScopeCheckerFromJwt(context);
        return new PatientAccessCheckerService(authorizedPatientId, context.patientFinder, smartScopeChecker);
    },
};
