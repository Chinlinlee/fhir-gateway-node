import { BLOCKED_SEARCH_MODIFIERS, CHAINING_PARAM_PATTERN } from "../constants/fhir";
import { InvalidRequestError } from "../errors/invalid-request.error";
import type { BundlePatients } from "../types/bundle-patients";
import { BundlePatientsBuilder } from "../types/bundle-patients";
import type { FhirBundle, FhirBundleEntry } from "../types/fhir-bundle";
import { findPatientIdsInResource } from "../utils/fhir-path.util";
import {
    checkFhirIdOrFail,
    isSameResourceType,
    parseDelimitedPatientIds,
    parsePatientIdFromToken,
    parseQueryString,
    parseResourcePath,
} from "../utils/fhir.util";
import { readResourceJson } from "../utils/load-resource";

const RESOURCE_ID_FIELD = "_id";
const PATCH_CONTENT_TYPE = "application/json-patch+json";
const PATCH_OPERATION = "op";
const PATCH_PATH = "path";
const PATCH_VALUE = "value";
const PATCH_OP_REPLACE = "replace";
const PATCH_OP_ADD = "add";

type CompartmentDefinitionJson = {
    resource?: Array<{
        code?: string;
        param?: string[];
    }>;
};

type PatientPathsJson = Record<string, string[]>;

/**
 * Extracts patient context from URLs, query params, and transaction Bundles.
 */
export class PatientFinderService {
    private static instance: PatientFinderService | null = null;

    private readonly patientSearchParams: Map<string, string[]>;
    private readonly patientFhirPaths: PatientPathsJson;
    private readonly blockJoins: boolean;

    private constructor(
        patientSearchParams: Map<string, string[]>,
        patientFhirPaths: PatientPathsJson,
        blockJoins: boolean,
    ) {
        this.patientSearchParams = patientSearchParams;
        this.patientFhirPaths = patientFhirPaths;
        this.blockJoins = blockJoins;
    }

    static getInstance(): PatientFinderService {
        if (!PatientFinderService.instance) {
            PatientFinderService.instance = PatientFinderService.create();
        }
        return PatientFinderService.instance;
    }

    static create(): PatientFinderService {
        const compartment = readResourceJson("CompartmentDefinition-patient.json") as CompartmentDefinitionJson;
        const patientSearchParams = buildPatientSearchParamMap(compartment);
        const patientFhirPaths = readResourceJson("patient_paths.json") as PatientPathsJson;
        return new PatientFinderService(patientSearchParams, patientFhirPaths, true);
    }

    findPatientsFromParams(requestPath: string, queryParams: Record<string, string[]>): Set<string> {
        const { resourceName, resourceId } = parseResourcePath(requestPath);

        if (!resourceName) {
            throw new InvalidRequestError(`No resource specified for request ${requestPath}`);
        }

        if (isSameResourceType(resourceName, "Patient")) {
            const patientIds = this.getPatientIdsFromPatientUrl(resourceId, queryParams);
            if (patientIds.size === 0) {
                throw new InvalidRequestError(`Patient ID cannot be found in ${requestPath}`);
            }
            return patientIds;
        }

        // Non-Patient: parse compartment params when present; else empty set (proxy injects later)
        const patientIds = this.checkParamsAndFindPatientIds(resourceName, queryParams);
        return patientIds ?? new Set();
    }

    findPatientsInBundle(bundle: FhirBundle): BundlePatients {
        if (bundle.type !== "transaction") {
            throw new InvalidRequestError("Bundle type needs to be transaction!");
        }

        const builder = new BundlePatientsBuilder();
        if (!bundle.entry || bundle.entry.length === 0) {
            return builder.build();
        }

        for (const entry of bundle.entry) {
            this.processBundleEntry(entry, builder);
        }

        return builder.build();
    }

    private getPatientIdsFromPatientUrl(resourceId: string | null, queryParams: Record<string, string[]>): Set<string> {
        if (resourceId) {
            return new Set([resourceId]);
        }

        const patientIdValues = queryParams[RESOURCE_ID_FIELD];
        if (patientIdValues && patientIdValues.length === 1) {
            return parseDelimitedPatientIds(patientIdValues[0] ?? "");
        }

        return new Set();
    }

    private checkParamsAndFindPatientIds(
        resourceName: string,
        queryParams: Record<string, string[]>,
    ): Set<string> | null {
        this.checkFhirJoinParams(queryParams);

        const searchParams = this.patientSearchParams.get(resourceName);
        if (!searchParams) {
            return null;
        }

        for (const param of searchParams) {
            const paramValues = queryParams[param];
            if (paramValues && paramValues.length === 1) {
                return parseDelimitedPatientIds(paramValues[0] ?? "");
            }
        }

        return null;
    }

    private checkFhirJoinParams(queryParams: Record<string, string[]>): void {
        if (!this.blockJoins) {
            return;
        }

        for (const queryParam of Object.keys(queryParams)) {
            if (CHAINING_PARAM_PATTERN.test(queryParam)) {
                throw new InvalidRequestError(`Search with chaining is blocked in param: ${queryParam}`);
            }

            if (BLOCKED_SEARCH_MODIFIERS.includes(queryParam as (typeof BLOCKED_SEARCH_MODIFIERS)[number])) {
                throw new InvalidRequestError(`Search with ${queryParam} is blocked!`);
            }
        }
    }

    private processBundleEntry(entry: FhirBundleEntry, builder: BundlePatientsBuilder): void {
        const request = entry.request;
        if (!request) {
            throw new InvalidRequestError("Bundle entry requires a request field!");
        }

        const method = request.method;
        const hasResource = entry.resource !== undefined;

        if (method !== "GET" && method !== "DELETE" && !hasResource) {
            throw new InvalidRequestError("Bundle entry requires a resource field!");
        }

        switch (method) {
            case "GET":
                this.processGet(request, builder);
                break;
            case "POST":
                this.processPost(entry, request, builder);
                break;
            case "PUT":
                this.processPut(entry, request, builder);
                break;
            case "PATCH":
                this.processPatch(entry, request, builder);
                break;
            case "DELETE":
                this.processDelete(request, builder);
                break;
            default:
                throw new InvalidRequestError(`HTTP request method ${method} is not supported!`);
        }
    }

    private processGet(request: fhir4.BundleEntryRequest, builder: BundlePatientsBuilder): void {
        const patientIds = this.findPatientIdsFromRequestUrl(request.url);
        for (const patientId of patientIds) {
            builder.addPatient("READ", patientId);
        }
    }

    private processPost(
        entry: FhirBundleEntry,
        _request: fhir4.BundleEntryRequest,
        builder: BundlePatientsBuilder,
    ): void {
        const resource = entry.resource;
        if (!resource) {
            throw new InvalidRequestError("Bundle entry requires a resource field!");
        }

        const resourceType = resource.resourceType;

        if (isSameResourceType(resourceType, "Patient")) {
            builder.setPatientCreationFlag(true);
            return;
        }

        this.addPatientReferencesFromResource(resource, resourceType, builder);
    }

    private processPut(
        entry: FhirBundleEntry,
        request: fhir4.BundleEntryRequest,
        builder: BundlePatientsBuilder,
    ): void {
        const resource = entry.resource;
        if (!resource) {
            throw new InvalidRequestError("Bundle entry requires a resource field!");
        }

        const resourceType = resource.resourceType;
        const patientIds = this.findPatientIdsFromRequestUrl(request.url);

        if (isSameResourceType(resourceType, "Patient")) {
            if (patientIds.size > 1) {
                throw new InvalidRequestError(`Invalid Put Request for Patient with multiple ids ${request.url}`);
            }
            const patientId = [...patientIds][0];
            if (patientId) {
                builder.addPatient("UPDATE", patientId);
            }
            return;
        }

        builder.addReferencedPatients(patientIds);
        this.addPatientReferencesFromResource(resource, resourceType, builder);
    }

    private processPatch(
        entry: FhirBundleEntry,
        request: fhir4.BundleEntryRequest,
        builder: BundlePatientsBuilder,
    ): void {
        const resource = entry.resource;
        if (!resource) {
            throw new InvalidRequestError("Bundle entry requires a resource field!");
        }

        const patientIds = this.findPatientIdsFromRequestUrl(request.url);
        // PATCH target 由 request.url 決定（body 為 Binary），非 Binary.resourceType
        const patchTargetIsPatient = this.isPatientRequestUrl(request.url);

        if (patchTargetIsPatient) {
            if (patientIds.size > 1) {
                throw new InvalidRequestError(`Invalid Patch Request for Patient with multiple ids ${request.url}`);
            }
            const patientId = [...patientIds][0];
            if (patientId) {
                builder.addPatient("UPDATE", patientId);
            }
        } else {
            builder.addReferencedPatients(patientIds);
        }

        if (resource.resourceType !== "Binary") {
            throw new InvalidRequestError("PATCH resource type must be Binary");
        }

        const binary = resource as fhir4.Binary;
        if (binary.contentType !== PATCH_CONTENT_TYPE) {
            throw new InvalidRequestError(`PATCH content type must be ${PATCH_CONTENT_TYPE}`);
        }

        const data = binary.data;
        if (typeof data !== "string") {
            throw new InvalidRequestError("PATCH Binary data must be base64 string");
        }

        const patchJson = Buffer.from(data, "base64").toString("utf8");
        const patchArray = JSON.parse(patchJson) as unknown;
        if (!Array.isArray(patchArray)) {
            throw new InvalidRequestError("Invalid patch!");
        }

        const inferredResourceName = this.inferResourceNameFromPatchUrl(request.url);
        const patientsInPatch = this.parseJsonArrayForPatch(patchArray, inferredResourceName);
        if (patientsInPatch.size > 0) {
            builder.addReferencedPatients(patientsInPatch);
        }
    }

    private processDelete(request: fhir4.BundleEntryRequest, builder: BundlePatientsBuilder): void {
        const patientIds = this.findPatientIdsFromRequestUrl(request.url);
        if (this.isPatientRequestUrl(request.url)) {
            builder.addDeletedPatients(patientIds);
        } else {
            builder.addReferencedPatients(patientIds);
        }
    }

    private addPatientReferencesFromResource(
        resource: fhir4.Resource,
        resourceType: string,
        builder: BundlePatientsBuilder,
    ): void {
        const paths = this.patientFhirPaths[resourceType];
        if (!paths) {
            throw new InvalidRequestError("Patient reference must exist in resource");
        }

        const referencePatientIds = findPatientIdsInResource(resource, paths);
        if (referencePatientIds.size === 0) {
            throw new InvalidRequestError("Patient reference must exist in resource");
        }

        builder.addReferencedPatients(referencePatientIds);
    }

    private findPatientIdsFromRequestUrl(url: string): Set<string> {
        if (!url) {
            throw new InvalidRequestError("Patient IDs cannot be found in ");
        }

        const parsed = new URL(url, "http://localhost");
        const path = parsed.pathname.replace(/^\/+/, "");
        const pathLower = path.toLowerCase();

        const pathParts = path.split("/").filter(Boolean);
        if (pathParts.length >= 2 && isSameResourceType(pathParts[0], "Patient")) {
            return new Set([checkFhirIdOrFail(pathParts[1] ?? "")]);
        }

        if (pathLower === "patient") {
            const queryParams = parseQueryString(parsed.search);
            const patientIdValues = queryParams[RESOURCE_ID_FIELD];
            if (patientIdValues && patientIdValues.length === 1) {
                return parseDelimitedPatientIds(patientIdValues[0] ?? "");
            }
        }

        if (pathParts.length >= 1) {
            const queryParams = parseQueryString(parsed.search);
            const patientIds = this.checkParamsAndFindPatientIds(pathParts[0] ?? "", queryParams);
            if (patientIds && patientIds.size > 0) {
                return patientIds;
            }
        }

        return new Set();
    }

    private isPatientRequestUrl(url: string): boolean {
        if (!url) {
            return false;
        }
        const parsed = new URL(url, "http://localhost");
        const path = parsed.pathname.replace(/^\/+/, "");
        const pathParts = path.split("/").filter(Boolean);
        return (
            (pathParts.length >= 2 && isSameResourceType(pathParts[0], "Patient")) || path.toLowerCase() === "patient"
        );
    }

    private inferResourceNameFromPatchUrl(url: string): string {
        const parsed = new URL(url, "http://localhost");
        const pathParts = parsed.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
        return pathParts[0] ?? "";
    }

    private parseJsonArrayForPatch(patchArray: unknown[], resourceName: string): Set<string> {
        const patientIds = new Set<string>();
        for (const element of patchArray) {
            if (!element || typeof element !== "object") {
                continue;
            }
            const patientId = this.parsePatchForPatientId(element as Record<string, unknown>, resourceName);
            if (patientId) {
                patientIds.add(patientId);
            }
        }
        return patientIds;
    }

    private parsePatchForPatientId(patch: Record<string, unknown>, resourceName: string): string | null {
        const pathValue = patch[PATCH_PATH];
        const opValue = patch[PATCH_OPERATION];
        if (typeof pathValue !== "string" || typeof opValue !== "string") {
            throw new InvalidRequestError("Invalid patch!");
        }

        const fhirPaths = this.patientFhirPaths[resourceName];
        if (!fhirPaths) {
            return null;
        }

        const containsPatientCompartment = fhirPaths.some((fhirPath) => pathValue.startsWith(`/${fhirPath}`));
        if (!containsPatientCompartment) {
            return null;
        }

        if (opValue !== PATCH_OP_REPLACE && opValue !== PATCH_OP_ADD) {
            throw new InvalidRequestError(`${opValue} operation on Patient Compartment is not supported!`);
        }

        const valueField = patch[PATCH_VALUE];
        if (Array.isArray(valueField) && valueField.length > 0) {
            throw new InvalidRequestError("non-empty JsonArray in 'value' for Patient Compartment is not supported!");
        }

        if (valueField && typeof valueField === "object" && !Array.isArray(valueField)) {
            const reference = (valueField as Record<string, unknown>).reference;
            if (typeof reference === "string") {
                const patientId = parsePatientIdFromToken(reference);
                if (!patientId) {
                    throw new InvalidRequestError("Expected patient reference!");
                }
                return patientId;
            }
        }

        if (typeof valueField === "string" && pathValue.includes("/reference")) {
            const patientId = parsePatientIdFromToken(valueField);
            if (!patientId) {
                throw new InvalidRequestError("Expected patient reference!");
            }
            return patientId;
        }

        return null;
    }
}

function buildPatientSearchParamMap(compartment: CompartmentDefinitionJson): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const resource of compartment.resource ?? []) {
        if (!resource.code || !resource.param || resource.param.length === 0) {
            continue;
        }
        map.set(resource.code, [...resource.param]);
    }
    return map;
}
