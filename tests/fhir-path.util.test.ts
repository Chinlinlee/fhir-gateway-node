import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { findPatientIdsInResource } from "../src/utils/fhir-path.util";
import { patientFinderFixturePath } from "./helpers/patient-finder-fixture";

describe("findPatientIdsInResource", () => {
    it("extracts Patient references from Observation paths", () => {
        const raw = readFileSync(patientFinderFixturePath("bundle_transaction_patient_and_non_patients.json"), "utf8");
        const bundle = JSON.parse(raw) as fhir4.Bundle;
        const observation = bundle.entry?.[0]?.resource as fhir4.Observation;
        expect(observation?.resourceType).toBe("Observation");

        const patientIds = findPatientIdsInResource(observation as fhir4.Resource, ["subject", "patient", "performer"]);

        expect(patientIds.has("420e791b-e419-c19b-3144-29e101c2c12f")).toBe(true);
        expect(patientIds.has("be92a43f-de46-affa-b131-bbf9eea51140")).toBe(true);
        expect(patientIds.size).toBe(2);
    });

    it("ignores non-Patient references (e.g. Practitioner)", () => {
        const careTeam: fhir4.CareTeam = {
            resourceType: "CareTeam",
            status: "active",
            participant: [
                { member: { reference: "Patient/patient-a" } },
                { member: { reference: "Practitioner/practitioner-b" } },
            ],
        };

        const patientIds = findPatientIdsInResource(careTeam, ["participant.member"]);

        expect([...patientIds]).toEqual(["patient-a"]);
    });

    it("returns empty set when paths match no Patient reference", () => {
        const observation: fhir4.Observation = {
            resourceType: "Observation",
            status: "final",
            code: { text: "test" },
            encounter: { reference: "Encounter/enc-1" },
        };

        const patientIds = findPatientIdsInResource(observation, ["subject"]);

        expect(patientIds.size).toBe(0);
    });
});
