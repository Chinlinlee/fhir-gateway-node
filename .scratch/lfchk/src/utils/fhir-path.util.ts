import { compile, type Model } from "fhirpath";
import fhirpathR4Model from "fhirpath/fhir-context/r4/index.js";

import { parsePatientIdFromToken } from "./fhir.util";

const FHIRPATH_R4_MODEL = fhirpathR4Model as Model;

/** Cache compiled paths to avoid re-parsing */
const compiledPathCache = new Map<string, (resource: fhir4.Resource) => unknown[]>();

function getCompiledPath(path: string): (resource: fhir4.Resource) => unknown[] {
    let evaluator = compiledPathCache.get(path);
    if (!evaluator) {
        evaluator = compile(path, FHIRPATH_R4_MODEL, { async: false }) as (resource: fhir4.Resource) => unknown[];
        compiledPathCache.set(path, evaluator);
    }
    return evaluator;
}

function extractPatientIdFromReferenceValue(value: unknown): string | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    const reference = (value as fhir4.Reference).reference;
    if (typeof reference !== "string") {
        return null;
    }

    return parsePatientIdFromToken(reference);
}

/**
 * Evaluates patient_paths.json entries via HL7 fhirpath.js, aligned with Java IFhirPath.
 */
export function findPatientIdsInResource(resource: fhir4.Resource, paths: string[]): Set<string> {
    const patientIds = new Set<string>();

    for (const path of paths) {
        const values = getCompiledPath(path)(resource);
        for (const value of values) {
            const patientId = extractPatientIdFromReferenceValue(value);
            if (patientId) {
                patientIds.add(patientId);
            }
        }
    }

    return patientIds;
}
