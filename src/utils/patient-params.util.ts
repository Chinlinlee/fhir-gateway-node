import { readResourceJson } from "./load-resource";

export type PatientParamsJson = Record<string, string>;

let cachedPatientParams: PatientParamsJson | null = null;

export function loadPatientParams(): PatientParamsJson {
    if (!cachedPatientParams) {
        cachedPatientParams = readResourceJson("patient_params.json") as PatientParamsJson;
    }
    return cachedPatientParams;
}

/** Proxy 注入用：該 ResourceType 的 primary patient compartment search param。 */
export function getPrimaryPatientSearchParam(resourceType: string): string | undefined {
    return loadPatientParams()[resourceType];
}
