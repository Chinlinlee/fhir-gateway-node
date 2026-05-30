import { Client } from "fhir-kit-client";

import { HTTP_NO_CACHE_FETCH_OPTIONS, HTTP_NO_CACHE_HEADERS } from "./http-no-cache.util";

export type FhirKitClient = Client;

export { HTTP_NO_CACHE_HEADERS as FHIR_KIT_CLIENT_NO_CACHE_HEADERS };

export type CreateFhirKitClientOptions = {
    baseUrl: string;
    bearerToken?: string;
};

/** 建立 fhir-kit-client 實例，強制禁用 HTTP 快取 / Create fhir-kit-client with HTTP cache disabled */
export function createFhirKitClient(options: CreateFhirKitClientOptions): Client {
    return new Client({
        baseUrl: options.baseUrl,
        customHeaders: { ...HTTP_NO_CACHE_HEADERS },
        requestOptions: { ...HTTP_NO_CACHE_FETCH_OPTIONS },
        ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
    });
}
