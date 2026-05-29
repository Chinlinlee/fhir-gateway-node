import { describe, expect, it } from "vitest";

import { accessGrantedAndUpdateListForPatient } from "../src/services/access-checkers/list-access-checker.util";
import { TEST_LIST_ID, readAccessCheckerFixture } from "./helpers/access-checker-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";
import { MockHttpFhirClient } from "./helpers/mock-http-fhir-client";

describe("accessGrantedAndUpdateList postProcess", () => {
    it("postProcessNewPatientPut", () => {
        const mockClient = new MockHttpFhirClient();
        const decision = accessGrantedAndUpdateListForPatient(TEST_LIST_ID, mockClient);
        const body = readAccessCheckerFixture("test_patient.json");
        decision.postProcess?.(buildFhirRequest("Patient/new-id", {}, "PUT"), {
            status: 200,
            body,
        });
        expect(mockClient.patchCalls.length).toBe(1);
        expect(mockClient.patchCalls[0]?.path).toBe(`List/${encodeURIComponent(TEST_LIST_ID)}`);
    });

    it("postProcessNewPatientPost", () => {
        const mockClient = new MockHttpFhirClient();
        const decision = accessGrantedAndUpdateListForPatient(TEST_LIST_ID, mockClient);
        const body = readAccessCheckerFixture("test_patient.json");
        decision.postProcess?.(buildFhirRequest("Patient", {}, "POST"), {
            status: 201,
            body,
        });
        expect(mockClient.patchCalls.length).toBe(1);
    });
});
