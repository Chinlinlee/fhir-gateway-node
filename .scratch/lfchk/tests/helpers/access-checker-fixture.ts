import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FhirBundle } from "../../src/types/fhir-bundle";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "access-checker");
const patientFinderFixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "patient-finder");

export const PATIENT_AUTHORIZED = "be92a43f-de46-affa-b131-bbf9eea51140";
export const PATIENT_NON_AUTHORIZED = "patient-non-authorized";
export const TEST_LIST_ID = "test-list";
export const PATIENT_IN_BUNDLE_1 = "420e791b-e419-c19b-3144-29e101c2c12f";
export const PATIENT_IN_BUNDLE_2 = "db6e42c7-04fc-4d9d-b394-9ff33a41e178";
export const DEFAULT_TEST_SCOPES_CLAIM = "patient/*.*";

export function accessCheckerFixturePath(fileName: string): string {
    return join(fixturesDir, fileName);
}

export function readAccessCheckerFixture(fileName: string): string {
    return readFileSync(accessCheckerFixturePath(fileName), "utf8");
}

export function readAccessCheckerBundleFromPatientFinder(fileName: string): FhirBundle {
    const raw = readFileSync(join(patientFinderFixturesDir, fileName), "utf8");
    return JSON.parse(raw) as FhirBundle;
}

export function readAccessCheckerJson<T>(fileName: string): T {
    return JSON.parse(readAccessCheckerFixture(fileName)) as T;
}
