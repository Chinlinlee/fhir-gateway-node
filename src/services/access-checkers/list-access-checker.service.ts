import { AuthenticationError } from "../../errors/authentication.error";
import { InvalidRequestError } from "../../errors/invalid-request.error";
import type {
    AccessChecker,
    AccessCheckerCreateContext,
    AccessCheckerFactory,
    PatientFinderLike,
} from "../../types/access-checker";
import type { AccessDecision } from "../../types/access-decision";
import type { BundlePatients } from "../../types/bundle-patients";
import type { FhirRequestDetails } from "../../types/fhir-request";
import type { HttpFhirClientLike } from "../../types/http-fhir-client";
import { getResourceIdOrNull, isSameResourceType, isValidFhirId, parseResourcePath } from "../../utils/fhir.util";
import { getJwtClaimIdOrFail } from "../../utils/jwt-claim.util";
import {
    accessGrantedAndUpdateListForBundle,
    accessGrantedAndUpdateListForPatient,
    deniedAccessDecision,
    grantedAccessDecision,
    parseRequestBundle,
    patientsExist,
    queryBuilder,
    serverListIncludesAllPatients,
    serverListIncludesAnyPatient,
    toPatientReferenceQueries,
} from "./list-access-checker.util";

export const PATIENT_LIST_CLAIM = "patient_list";

export class ListAccessCheckerService implements AccessChecker {
    private readonly httpFhirClient: HttpFhirClientLike;
    private readonly patientListId: string;
    private readonly patientFinder: PatientFinderLike;

    constructor(httpFhirClient: HttpFhirClientLike, patientListId: string, patientFinder: PatientFinderLike) {
        this.httpFhirClient = httpFhirClient;
        this.patientListId = patientListId;
        this.patientFinder = patientFinder;
    }

    checkAccess(request: FhirRequestDetails): AccessDecision {
        try {
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
                    return this.processPut(request);
                case "PATCH":
                    return this.processPatch(request);
                case "DELETE":
                    return this.processDelete(request);
                default:
                    return deniedAccessDecision();
            }
        } catch (error) {
            if (error instanceof InvalidRequestError) {
                throw error;
            }
            return deniedAccessDecision();
        }
    }

    private processGet(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (isSameResourceType(resourceName, "List")) {
            const listId = getResourceIdOrNull(request.requestPath);
            return grantedAccessDecision(listId === this.patientListId);
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            serverListIncludesAllPatients(
                this.httpFhirClient,
                this.patientListId,
                toPatientReferenceQueries(patientIds),
            ),
        );
    }

    private processPost(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (isSameResourceType(resourceName, "Patient")) {
            return accessGrantedAndUpdateListForPatient(this.patientListId, this.httpFhirClient);
        }

        const body = request.requestBody;
        if (!body) {
            return deniedAccessDecision();
        }

        const patientIds = this.patientFinder.findPatientsInResource(request.requestPath, body);
        return grantedAccessDecision(serverListIncludesAnyPatient(this.httpFhirClient, this.patientListId, patientIds));
    }

    private processPut(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (isSameResourceType(resourceName, "Patient")) {
            const patientDecision = this.checkPatientAccessInUpdate(request);
            if (patientDecision) {
                return patientDecision;
            }
            return accessGrantedAndUpdateListForPatient(this.patientListId, this.httpFhirClient);
        }

        return this.checkNonPatientAccessInUpdate(request, "PUT");
    }

    private processPatch(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (isSameResourceType(resourceName, "Patient")) {
            const patientDecision = this.checkPatientAccessInUpdate(request);
            if (!patientDecision) {
                return deniedAccessDecision();
            }
            return patientDecision;
        }

        return this.checkNonPatientAccessInUpdate(request, "PATCH");
    }

    private processDelete(request: FhirRequestDetails): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);

        if (isSameResourceType(resourceName, "List")) {
            const listId = getResourceIdOrNull(request.requestPath);
            if (listId === this.patientListId) {
                return deniedAccessDecision();
            }
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        return grantedAccessDecision(
            serverListIncludesAllPatients(
                this.httpFhirClient,
                this.patientListId,
                toPatientReferenceQueries(patientIds),
            ),
        );
    }

    private checkNonPatientAccessInUpdate(request: FhirRequestDetails, updateMethod: "PUT" | "PATCH"): AccessDecision {
        const { resourceName } = parseResourcePath(request.requestPath);
        if (!resourceName) {
            return deniedAccessDecision();
        }

        const patientIds = this.patientFinder.findPatientsForAccessCheck(request.requestPath, request.queryParams);
        const patientQueries = toPatientReferenceQueries(patientIds);

        let patientSet = new Set<string>();
        const body = request.requestBody;

        if (updateMethod === "PATCH") {
            if (!body) {
                return deniedAccessDecision();
            }
            patientSet = this.patientFinder.findPatientsInPatch(body, resourceName);
        }

        if (updateMethod === "PUT") {
            if (!body) {
                return deniedAccessDecision();
            }
            patientSet = this.patientFinder.findPatientsInResource(request.requestPath, body);
            if (patientSet.size === 0) {
                return deniedAccessDecision();
            }
        }

        if (patientSet.size > 0) {
            patientQueries.add(queryBuilder(patientSet, "Patient/", ","));
        }

        return grantedAccessDecision(
            serverListIncludesAllPatients(this.httpFhirClient, this.patientListId, patientQueries),
        );
    }

    private checkPatientAccessInUpdate(request: FhirRequestDetails): AccessDecision | null {
        const patientId = getResourceIdOrNull(request.requestPath);
        if (!patientId || !isValidFhirId(patientId)) {
            return deniedAccessDecision();
        }

        if (patientsExist(this.httpFhirClient, patientId)) {
            return grantedAccessDecision(
                serverListIncludesAnyPatient(this.httpFhirClient, this.patientListId, new Set([patientId])),
            );
        }

        return null;
    }

    private processBundle(request: FhirRequestDetails): AccessDecision {
        const bundle = parseRequestBundle(request);
        if (!bundle) {
            return deniedAccessDecision();
        }

        const filteredPatients = this.createBundlePatients(bundle);
        if (!filteredPatients) {
            return deniedAccessDecision();
        }

        if (!filteredPatients.patientsToCreate && filteredPatients.updatedPatients.size === 0) {
            return grantedAccessDecision(true);
        }

        if (filteredPatients.updatedPatients.size === 0) {
            return accessGrantedAndUpdateListForBundle(this.patientListId, this.httpFhirClient, new Set());
        }

        return accessGrantedAndUpdateListForBundle(
            this.patientListId,
            this.httpFhirClient,
            filteredPatients.updatedPatients,
        );
    }

    private createBundlePatients(bundle: fhir4.Bundle): BundlePatients | null {
        const patientsInBundleUnfiltered = this.patientFinder.findPatientsInBundle(bundle, { strict: true });
        const patientsToCreate = new Set<string>();
        const patientsToUpdate = new Set<string>();
        const patientsToDelete = patientsInBundleUnfiltered.deletedPatients;
        let hasPatientCreation = patientsInBundleUnfiltered.patientsToCreate;

        for (const patientId of patientsInBundleUnfiltered.updatedPatients) {
            if (!patientsExist(this.httpFhirClient, patientId)) {
                patientsToCreate.add(patientId);
            } else {
                patientsToUpdate.add(patientId);
            }
        }

        if (patientsToCreate.size > 0) {
            hasPatientCreation = true;
        }

        const patientQueries = new Set<string>();

        for (const patientRefSet of patientsInBundleUnfiltered.referencedPatients) {
            const refs = [...patientRefSet];
            const overlapsCreate = refs.some((id) => patientsToCreate.has(id));
            const overlapsDelete = refs.some((id) => patientsToDelete.has(id));
            if (!overlapsCreate && !overlapsDelete) {
                patientQueries.add(queryBuilder(patientRefSet, "Patient/", ","));
            }
        }

        for (const eachPatient of patientsToUpdate) {
            patientQueries.add(`Patient/${eachPatient}`);
        }

        for (const eachPatient of patientsToDelete) {
            patientQueries.add(`Patient/${eachPatient}`);
        }

        if (
            patientQueries.size > 0 &&
            !serverListIncludesAllPatients(this.httpFhirClient, this.patientListId, patientQueries)
        ) {
            return null;
        }

        return {
            referencedPatients: patientsInBundleUnfiltered.referencedPatients,
            updatedPatients: patientsToUpdate,
            deletedPatients: patientsToDelete,
            patientsToCreate: hasPatientCreation,
        };
    }
}

export const listAccessCheckerFactory: AccessCheckerFactory = {
    create(context: AccessCheckerCreateContext): AccessChecker {
        const httpFhirClient = context.httpFhirClient;
        if (!httpFhirClient) {
            throw new AuthenticationError("ListAccessChecker requires httpFhirClient");
        }

        const patientListId = getJwtClaimIdOrFail(context.jwt.payload, PATIENT_LIST_CLAIM);
        return new ListAccessCheckerService(httpFhirClient, patientListId, context.patientFinder);
    },
};
