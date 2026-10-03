import { describe, expect, it } from "vitest";

import { patientAccessCheckerFactory } from "../src/services/access-checkers/patient-access-checker.service";
import { PatientFinderService } from "../src/services/patient-finder.service";
import { PATIENT_AUTHORIZED, PATIENT_NON_AUTHORIZED } from "./helpers/access-checker-fixture";
import { launchContextFromClaims } from "./helpers/launch-context-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";

describe("PatientAccessChecker use cases", () => {
    it("supports mixed system and patient scopes by resource type", () => {
        const checker = patientAccessCheckerFactory.create({
            launch: launchContextFromClaims({
                patient: PATIENT_AUTHORIZED,
                scope: "system/*.r patient/*.rs",
            }),
            patientFinder: PatientFinderService.getInstance(),
        });

        expect(checker.checkAccess(buildFhirRequest("Location/loc-001")).canAccess()).toBe(true);
        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_AUTHORIZED}`)).canAccess()).toBe(true);
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("Encounter", {
                        patient: [PATIENT_AUTHORIZED],
                    }),
                )
                .canAccess(),
        ).toBe(true);

        expect(checker.checkAccess(buildFhirRequest(`Patient/${PATIENT_NON_AUTHORIZED}`)).canAccess()).toBe(false);
        expect(
            checker
                .checkAccess(
                    buildFhirRequest("Encounter", {
                        patient: [PATIENT_NON_AUTHORIZED],
                    }),
                )
                .canAccess(),
        ).toBe(false);
    });
});
