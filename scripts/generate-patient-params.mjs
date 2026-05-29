/**
 * 從 CompartmentDefinition-patient.json 產生 patient_params.json（proxy 注入用 search param）。
 *
 * 優先順序：patient > subject > 第一個 compartment param（對齊 R4 Patient compartment search）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compartmentPath = join(root, "src/resources/CompartmentDefinition-patient.json");
const outputPath = join(root, "src/resources/patient_params.json");

function pickPrimaryParam(params) {
    if (params.includes("patient")) {
        return "patient";
    }
    if (params.includes("subject")) {
        return "subject";
    }
    return params[0];
}

const compartment = JSON.parse(readFileSync(compartmentPath, "utf8"));
const patientParams = {};

for (const resource of compartment.resource ?? []) {
    if (!resource.code || !resource.param?.length) {
        continue;
    }
    patientParams[resource.code] = pickPrimaryParam(resource.param);
}

writeFileSync(outputPath, `${JSON.stringify(patientParams, null, 4)}\n`);
console.log(`Wrote ${Object.keys(patientParams).length} entries to ${outputPath}`);
