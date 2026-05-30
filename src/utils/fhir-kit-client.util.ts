import { Client } from "fhir-kit-client";

export type FhirKitClient = Client;

export const FHIR_KIT_CLIENT_NO_CACHE_HEADERS = {
    "Cache-Control": "no-cache, no-store",
    Pragma: "no-cache",
} as const;

export type CreateFhirKitClientOptions = {
    baseUrl: string;
    bearerToken?: string;
};

/** 建立 fhir-kit-client 實例，強制禁用 HTTP 快取 / Create fhir-kit-client with HTTP cache disabled */
export function createFhirKitClient(options: CreateFhirKitClientOptions): Client {
    return new Client({
        baseUrl: options.baseUrl,
        customHeaders: { ...FHIR_KIT_CLIENT_NO_CACHE_HEADERS },
        requestOptions: { cache: "no-store" },
        ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
    });
}
