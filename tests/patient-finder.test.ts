import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { InvalidRequestError } from "../src/errors/invalid-request.error";
import { PatientFinderService } from "../src/services/patient-finder.service";
import type { FhirBundle } from "../src/types/fhir-bundle";
import { isValidFhirId, parseResourcePath } from "../src/utils/fhir.util";
import { patientFinderFixturePath, readPatientFinderBundle } from "./helpers/patient-finder-fixture";

describe("fhir.util isValidFhirId", () => {
    it("isValidIdPass", () => {
        expect(isValidFhirId("simple-id")).toBe(true);
    });

    it("isValidIdDotPass", () => {
        expect(isValidFhirId("id.with.dots")).toBe(true);
    });

    it("isValidIdUnderscoreFails", () => {
        expect(isValidFhirId("id_with_underscore")).toBe(false);
    });

    it("isValidIdTooLong", () => {
        expect(
            isValidFhirId("too-long-id-0123456789012345678901234567890123456789012345678901234567890123456789"),
        ).toBe(false);
    });
});

describe("PatientFinderService.findPatientsFromParams", () => {
    const finder = PatientFinderService.getInstance();

    it("GET /Patient/{id} returns single patient", () => {
        const ids = finder.findPatientsFromParams("Patient/be92a43f-de46-affa-b131-bbf9eea51140", {});
        expect([...ids]).toEqual(["be92a43f-de46-affa-b131-bbf9eea51140"]);
    });

    it("GET /Patient?_id= comma-separated ids", () => {
        const ids = finder.findPatientsFromParams("Patient", {
            _id: ["be92a43f-de46-affa-b131-bbf9eea51140,420e791b-e419-c19b-3144-29e101c2c12f"],
        });
        expect(ids.size).toBe(2);
        expect(ids.has("be92a43f-de46-affa-b131-bbf9eea51140")).toBe(true);
        expect(ids.has("420e791b-e419-c19b-3144-29e101c2c12f")).toBe(true);
    });

    it("GET /Encounter?patient= compartment search", () => {
        const ids = finder.findPatientsFromParams("Encounter", {
            patient: ["be92a43f-de46-affa-b131-bbf9eea51140"],
        });
        expect([...ids]).toEqual(["be92a43f-de46-affa-b131-bbf9eea51140"]);
    });

    it("GET /Encounter/{id} rejects direct resource fetch", () => {
        expect(() => finder.findPatientsFromParams("Encounter/enc-123", {})).toThrow(InvalidRequestError);
    });

    it("blocks chaining search params", () => {
        expect(() =>
            finder.findPatientsFromParams("Observation", {
                "subject.name": ["Smith"],
            }),
        ).toThrow(/chaining is blocked/);
    });

    it("blocks _has search param", () => {
        expect(() =>
            finder.findPatientsFromParams("Observation", {
                _has: ["Patient:Observation.subject:abc"],
            }),
        ).toThrow(/_has is blocked/);
    });

    it("rejects when patient cannot be inferred", () => {
        expect(() => finder.findPatientsFromParams("Observation", {})).toThrow(InvalidRequestError);
    });
});

describe("PatientFinderService.findPatientsInBundle", () => {
    const finder = PatientFinderService.getInstance();

    it("canParseValidTransactionBundle entries count", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_put_patient.json");
        const result = finder.findPatientsInBundle(bundle);
        expect(result.updatedPatients.size).toBe(2);
    });

    it("bundle_transaction_get_non_patient_authorized", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_get_non_patient_authorized.json");
        const result = finder.findPatientsInBundle(bundle);
        expect(result.referencedPatients).toHaveLength(1);
        expect([...(result.referencedPatients[0] ?? [])]).toEqual(["be92a43f-de46-affa-b131-bbf9eea51140"]);
    });

    it("bundle_transaction_post_patient sets patientsToCreate", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_post_patient.json");
        const result = finder.findPatientsInBundle(bundle);
        expect(result.patientsToCreate).toBe(true);
    });

    it("bundle_transaction_patch_authorized", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_patch_authorized.json");
        const result = finder.findPatientsInBundle(bundle);
        expect(result.updatedPatients.has("be92a43f-de46-affa-b131-bbf9eea51140")).toBe(true);
        expect(result.referencedPatients.length).toBeGreaterThan(0);
    });

    it("bundle_transaction_delete_patient", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_delete_patient.json");
        const result = finder.findPatientsInBundle(bundle);
        expect(result.deletedPatients.size).toBeGreaterThan(0);
    });

    it("rejects non-transaction bundle type", () => {
        const raw = readFileSync(patientFinderFixturePath("patient_id_search.json"), "utf8");
        const bundle = JSON.parse(raw) as FhirBundle;
        expect(() => finder.findPatientsInBundle(bundle)).toThrow(/transaction/);
    });

    it("bundle_transaction_no_resource_field throws", () => {
        const bundle = readPatientFinderBundle("bundle_transaction_no_resource_field.json");
        expect(() => finder.findPatientsInBundle(bundle)).toThrow(/requires a resource field/);
    });

    it("empty transaction bundle returns empty sets", () => {
        const bundle: FhirBundle = {
            resourceType: "Bundle",
            type: "transaction",
            entry: [],
        };
        const result = finder.findPatientsInBundle(bundle);
        expect(result.patientsToCreate).toBe(false);
        expect(result.referencedPatients).toHaveLength(0);
    });
});

describe("parseResourcePath", () => {
    it("parses type and id", () => {
        expect(parseResourcePath("Patient/abc-123")).toEqual({
            resourceName: "Patient",
            resourceId: "abc-123",
        });
    });
});
