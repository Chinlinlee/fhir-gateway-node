/// <reference types="fhir" />

import { normalizeFhirClientPath } from "../../src/services/access-checkers/list-access-checker.util";
import type { HttpFhirClientLike } from "../../src/types/http-fhir-client";

export class MockHttpFhirClient implements HttpFhirClientLike {
    private readonly getResponses = new Map<string, fhir4.Bundle>();
    readonly patchCalls: Array<{ path: string; body: string }> = [];

    registerGet(path: string, bundle: fhir4.Bundle): void {
        this.getResponses.set(normalizeFhirClientPath(path), bundle);
    }

    getResource(path: string): fhir4.Bundle {
        const bundle = this.getResponses.get(normalizeFhirClientPath(path));
        if (!bundle) {
            throw new Error(`No mock GET response registered for path: ${path}`);
        }
        return bundle;
    }

    patchResource(path: string, jsonPatch: string): void {
        this.patchCalls.push({ path, body: jsonPatch });
    }
}
