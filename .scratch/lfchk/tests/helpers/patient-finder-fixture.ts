import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FhirBundle } from "../../src/types/fhir-bundle";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "patient-finder");

export function patientFinderFixturePath(fileName: string): string {
    return join(fixturesDir, fileName);
}

export function readPatientFinderBundle(fileName: string): FhirBundle {
    const raw = readFileSync(patientFinderFixturePath(fileName), "utf8");
    return JSON.parse(raw) as FhirBundle;
}
