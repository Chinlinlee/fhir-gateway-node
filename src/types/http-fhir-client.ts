/// <reference types="fhir" />

/** Phase 7 實作；AccessChecker 單元測試以 in-memory mock 注入。 */
export type HttpFhirClientLike = {
    getResource: (path: string) => fhir4.Bundle;
    patchResource: (path: string, jsonPatch: string) => void;
};
