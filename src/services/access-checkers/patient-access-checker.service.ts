import { AuthenticationError } from "../../errors/authentication.error";
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
import { getPatientReferenceOrFail } from "../../utils/launch-context.util";
import { LAUNCH_CLAIM_NAMES } from "../launch-context.service";
import {
    type SmartFhirScope,
    SmartScopeChecker,
    SmartScopePermission,
    SmartScopePrincipal,
} from "../smart-scope.service";
import { deniedAccessDecision, grantedAccessDecision, parseRequestBundle } from "./list-access-checker.util";

/**
 * Scope claim 名稱；唯一來源為 `LAUNCH_CLAIM_NAMES`（設定化見 issue #8）。
 * Claim name for the SMART scopes. 病人參照的 claim 名稱已隨 ADR-0002 移除——
 * launch context 的病人由 gateway 自己的 store 提供，不在 token 裡。
 */
export const SCOPES_CLAIM = LAUNCH_CLAIM_NAMES.scopes;

export class PatientAccessCheckerService implements AccessChecker {
    private readonly authorizedPatientId: string | null;
    private readonly patientFinder: PatientFinderLike;
    private readonly scopeCheckersByPrincipal: Map<SmartScopePrincipal, SmartScopeChecker>;

    constructor(
        authorizedPatientId: string | null,
        patientFinder: PatientFinderLike,
        scopeCheckersByPrincipal: Map<SmartScopePrincipal, SmartScopeChecker>,
    ) {
        this.authorizedPatientId = authorizedPatientId;
        this.patientFinder = patientFinder;
        this.scopeCheckersByPrincipal = scopeCheckersByPrincipal;
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
        if (this.authorizedPatientId === null) {
            return true;
        }
        return patientIds.size === 1 && patientIds.has(this.authorizedPatientId);
    }

    private hasPermissionWithPrincipal(
        principal: SmartScopePrincipal,
        resourceName: string,
        permission: SmartScopePermission,
    ): boolean {
        const checker = this.scopeCheckersByPrincipal.get(principal);
        return checker?.hasPermission(resourceName, permission) ?? false;
    }

    private hasBroadPermission(resourceName: string, permission: SmartScopePermission): boolean {
        return (
            this.hasPermissionWithPrincipal(SmartScopePrincipal.SYSTEM, resourceName, permission) ||
            this.hasPermissionWithPrincipal(SmartScopePrincipal.USER, resourceName, permission)
        );
    }

    private hasPatientPermission(resourceName: string, permission: SmartScopePermission): boolean {
        return this.hasPermissionWithPrincipal(SmartScopePrincipal.PATIENT, resourceName, permission);
    }

    private shouldUsePatientPrincipal(resourceName: string): boolean {
        return this.authorizedPatientId !== null && this.patientFinder.isPatientCompartmentResource(resourceName);
    }

    private processRead(request: FhirRequestDetails, resourceName: string): AccessDecision {
        if (!this.shouldUsePatientPrincipal(resourceName)) {
            return grantedAccessDecision(this.hasBroadPermission(resourceName, SmartScopePermission.READ));
        }

        const patientIds = isSameResourceType(resourceName, "Patient")
            ? this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams)
            : this.patientFinder.findPatientsFromParams(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) && this.hasPatientPermission(resourceName, SmartScopePermission.READ),
        );
    }

    private processSearch(request: FhirRequestDetails, resourceName: string): AccessDecision {
        if (!this.shouldUsePatientPrincipal(resourceName)) {
            return grantedAccessDecision(this.hasBroadPermission(resourceName, SmartScopePermission.SEARCH));
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) && this.hasPatientPermission(resourceName, SmartScopePermission.SEARCH),
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

        if (!this.shouldUsePatientPrincipal(resourceName)) {
            return grantedAccessDecision(this.hasBroadPermission(resourceName, SmartScopePermission.CREATE));
        }

        const patientIds = this.patientFinder.findPatientsInResource(request.requestPath, body);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) && this.hasPatientPermission(resourceName, SmartScopePermission.CREATE),
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

        if (!this.shouldUsePatientPrincipal(resourceName)) {
            return grantedAccessDecision(this.hasBroadPermission(resourceName, SmartScopePermission.DELETE));
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            this.validatePatientIds(patientIds) && this.hasPatientPermission(resourceName, SmartScopePermission.DELETE),
        );
    }

    private checkNonPatientAccessInUpdate(
        request: FhirRequestDetails,
        resourceName: string,
        updateMethod: "PUT" | "PATCH",
    ): AccessDecision {
        const body = request.requestBody;
        if (!body) {
            return deniedAccessDecision();
        }

        if (!this.shouldUsePatientPrincipal(resourceName)) {
            if (this.authorizedPatientId !== null && this.patientFinder.isPatientCompartmentResource(resourceName)) {
                if (updateMethod === "PATCH") {
                    this.patientFinder.findPatientsInPatch(body, resourceName);
                }
                if (updateMethod === "PUT") {
                    this.patientFinder.findPatientsInResource(request.requestPath, body);
                }
            }
            return grantedAccessDecision(this.hasBroadPermission(resourceName, SmartScopePermission.UPDATE));
        }

        const referencedPatientIds = this.patientFinder.findPatientsForAccessCheck(
            request.requestPath,
            request.queryParams,
        );
        if (!this.validatePatientIds(referencedPatientIds)) {
            return deniedAccessDecision();
        }

        let patientIds = new Set<string>();

        if (updateMethod === "PATCH") {
            patientIds = this.patientFinder.findPatientsInPatch(body, resourceName);
            if (patientIds.size === 0) {
                return grantedAccessDecision(true);
            }
        }

        if (updateMethod === "PUT") {
            patientIds = this.patientFinder.findPatientsInResource(request.requestPath, body);
        }

        return grantedAccessDecision(
            this.validatePatientIds(patientIds) && this.hasPatientPermission(resourceName, SmartScopePermission.UPDATE),
        );
    }

    private checkPatientAccessInUpdate(request: FhirRequestDetails): AccessDecision {
        const patientId = getResourceIdOrNull(request.requestPath);
        if (!patientId) {
            return deniedAccessDecision();
        }

        if (!this.shouldUsePatientPrincipal("Patient")) {
            return grantedAccessDecision(this.hasBroadPermission("Patient", SmartScopePermission.UPDATE));
        }

        return grantedAccessDecision(
            this.authorizedPatientId === patientId && this.hasPatientPermission("Patient", SmartScopePermission.UPDATE),
        );
    }

    private processBundle(request: FhirRequestDetails): AccessDecision {
        const bundle = parseRequestBundle(request);
        if (!bundle) {
            return deniedAccessDecision();
        }

        if (this.authorizedPatientId === null) {
            for (const entry of bundle.entry ?? []) {
                if (!this.doesBundleElementHavePermission(entry)) {
                    return deniedAccessDecision();
                }
            }
            return grantedAccessDecision(true);
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
                if (this.shouldUsePatientPrincipal(resourceType)) {
                    return this.hasPatientPermission(resourceType, SmartScopePermission.CREATE);
                }
                return this.hasBroadPermission(resourceType, SmartScopePermission.CREATE);
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
            return false;
        }

        if (this.shouldUsePatientPrincipal(resourceType)) {
            return this.hasPatientPermission(resourceType, permission);
        }
        return this.hasBroadPermission(resourceType, permission);
    }
}

function createSmartScopeCheckers(scopes: readonly SmartFhirScope[]): Map<SmartScopePrincipal, SmartScopeChecker> {
    const checkers = new Map<SmartScopePrincipal, SmartScopeChecker>();
    for (const principal of [SmartScopePrincipal.PATIENT, SmartScopePrincipal.USER, SmartScopePrincipal.SYSTEM]) {
        checkers.set(principal, new SmartScopeChecker(scopes, principal));
    }
    return checkers;
}

export const patientAccessCheckerFactory: AccessCheckerFactory = {
    create(context: AccessCheckerCreateContext): AccessChecker {
        const scopes = context.launch.scopes;
        if (scopes.length === 0) {
            throw new AuthenticationError("No SMART FHIR scopes found in launch context");
        }

        const hasPatientScope = scopes.some((scope) => scope.principal === SmartScopePrincipal.PATIENT);
        const hasBroadScope = scopes.some(
            (scope) => scope.principal === SmartScopePrincipal.SYSTEM || scope.principal === SmartScopePrincipal.USER,
        );

        let authorizedPatientId: string | null = null;
        if (hasPatientScope) {
            try {
                authorizedPatientId = getPatientReferenceOrFail(context.launch, "patientId");
            } catch {
                if (!hasBroadScope) {
                    throw new AuthenticationError(
                        "Missing required launch context field: patientId (required for patient scopes)",
                    );
                }
            }
        }

        return new PatientAccessCheckerService(
            authorizedPatientId,
            context.patientFinder,
            createSmartScopeCheckers(scopes),
        );
    },
};
