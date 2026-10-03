import { describe, expect, it } from "vitest";

import { accessGrantedAndUpdateListForPatient } from "../src/services/access-checkers/list-access-checker.util";
import { readAccessCheckerFixture, TEST_LIST_ID } from "./helpers/access-checker-fixture";
import { buildFhirRequest } from "./helpers/fhir-request";
import { MockHttpFhirClient } from "./helpers/mock-http-fhir-client";

/** test_patient.json 的 resource.id；postProcess 加進 access List 的就是這個 id。 */
const PATIENT_FIXTURE_ID = "be92a43f-de46-affa-b131-bbf9eea51140";

describe("accessGrantedAndUpdateList postProcess", () => {
    it("postProcessNewPatientPut", async () => {
        const mockClient = new MockHttpFhirClient();
        const decision = accessGrantedAndUpdateListForPatient(TEST_LIST_ID, mockClient);
        const body = readAccessCheckerFixture("test_patient.json");

        const processed = await decision.postProcess?.(buildFhirRequest("Patient/new-id", {}, "PUT"), {
            status: 200,
            body,
        });

        expect(processed).toBe(body);
        // 新建的 patient id 取自回應 body 的 resource.id，而不是請求 path
        expect(mockClient.patchCalls).toEqual([
            {
                path: `List/${encodeURIComponent(TEST_LIST_ID)}`,
                body: JSON.stringify([
                    {
                        op: "add",
                        path: "/entry/-",
                        value: { item: { reference: `Patient/${PATIENT_FIXTURE_ID}` } },
                    },
                ]),
            },
        ]);
    });

    it("postProcessNewPatientPost", async () => {
        const mockClient = new MockHttpFhirClient();
        const decision = accessGrantedAndUpdateListForPatient(TEST_LIST_ID, mockClient);
        const body = readAccessCheckerFixture("test_patient.json");

        const processed = await decision.postProcess?.(buildFhirRequest("Patient", {}, "POST"), {
            status: 201,
            body,
        });

        expect(processed).toBe(body);
        expect(mockClient.patchCalls.length).toBe(1);
    });

    it("rejects once the awaited backend patch fails, so callers can observe the failure", async () => {
        const failingClient = new MockHttpFhirClient();
        failingClient.patchResource = () => Promise.reject(new Error("List PATCH rejected by the backend"));
        const decision = accessGrantedAndUpdateListForPatient(TEST_LIST_ID, failingClient);

        await expect(
            decision.postProcess?.(buildFhirRequest("Patient", {}, "POST"), {
                status: 201,
                body: readAccessCheckerFixture("test_patient.json"),
            }),
        ).rejects.toThrow("List PATCH rejected by the backend");
    });
});
