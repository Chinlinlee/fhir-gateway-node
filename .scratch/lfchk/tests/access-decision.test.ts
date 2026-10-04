import { describe, expect, it } from "vitest";

import { accessDecisionWithMutation } from "../src/types/access-decision";
import type { FhirRequestDetails } from "../src/types/fhir-request";
import { applyRequestMutation } from "../src/utils/request-mutation.util";

const emptyRequest: FhirRequestDetails = {
    requestPath: "Observation",
    requestType: "GET",
    queryParams: {},
};

describe("applyRequestMutation", () => {
    it("mutateRequest overwrites and adds query params", () => {
        const queryParams: Record<string, string[]> = {
            param1: ["param1-value1"],
            param2: ["param2-value1"],
        };

        const mutation = {
            additionalQueryParams: {
                param1: ["param1-value2"],
                param3: ["param3-value1", "param3-value2"],
            },
        };

        const result = applyRequestMutation(queryParams, mutation);

        expect(result.param1).toEqual(["param1-value2"]);
        expect(result.param2).toEqual(["param2-value1"]);
        expect(result.param3).toEqual(["param3-value1", "param3-value2"]);
    });

    it("mutateRequestRemoveQueryParams removes discarded params", () => {
        const queryParams: Record<string, string[]> = {
            param1: ["param1-value1"],
            param2: ["param2-value1"],
        };

        const result = applyRequestMutation(queryParams, {
            discardQueryParams: ["param1"],
        });

        expect(result.param1).toBeUndefined();
        expect(Object.keys(result)).toHaveLength(1);
        expect(result.param2).toEqual(["param2-value1"]);
    });

    it("returns same params when mutation is null or empty", () => {
        const queryParams = { a: ["1"] };
        expect(applyRequestMutation(queryParams, null)).toBe(queryParams);
        expect(applyRequestMutation(queryParams, {})).toBe(queryParams);
        expect(applyRequestMutation(queryParams, { additionalQueryParams: {}, discardQueryParams: [] })).toBe(
            queryParams,
        );
    });
});

describe("accessDecisionWithMutation", () => {
    it("exposes mutation only after canAccess is true", () => {
        const decision = accessDecisionWithMutation(true, () => ({
            additionalQueryParams: { patient: ["Patient/p1"] },
        }));

        expect(decision.canAccess()).toBe(true);
        const mutation = decision.getRequestMutation?.(emptyRequest);
        expect(mutation?.additionalQueryParams?.patient).toEqual(["Patient/p1"]);
    });
});
