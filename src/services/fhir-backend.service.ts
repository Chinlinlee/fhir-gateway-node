/// <reference types="fhir" />

import type { OpPatch } from "fhir-kit-client";

import { InvalidRequestError } from "../errors/invalid-request.error";
import { createFhirKitClient, type FhirKitClient } from "../utils/fhir-kit-client.util";

type FhirBackendServiceOptions = {
    baseUrl: string;
    /**
     * 每次請求前解析 bearer token。GCP 部署走 ADC，token 會過期，因此不能在建構時取一次。
     * 未提供時不帶 Authorization header。
     */
    getBearerToken?: () => Promise<string>;
};

type ParsedResourcePath = {
    resourceType: string;
    resourceId: string;
};

function trimLeadingSlash(path: string): string {
    return path.replace(/^\/+/, "");
}

function parseResourcePathOrFail(path: string): ParsedResourcePath {
    const normalized = trimLeadingSlash(path).split("?")[0] ?? "";
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    const resourceType = segments[0];
    const resourceId = segments[1];
    if (!resourceType || !resourceId) {
        throw new InvalidRequestError(`Expected resource path with id, got: ${path}`);
    }
    return { resourceType, resourceId };
}

export class FhirBackendService {
    private readonly client: FhirKitClient;
    private readonly getBearerToken: (() => Promise<string>) | undefined;

    constructor(options: FhirBackendServiceOptions) {
        this.client = createFhirKitClient({ baseUrl: options.baseUrl });
        this.getBearerToken = options.getBearerToken;
    }

    private async authorize(): Promise<void> {
        if (!this.getBearerToken) {
            return;
        }
        this.client.bearerToken = await this.getBearerToken();
    }

    /** backend 查詢與 AuditEvent 寫入都走同一組憑證，與轉發用的一致。 */
    async getResource(path: string): Promise<fhir4.Bundle> {
        await this.authorize();
        const resource = await this.client.request(trimLeadingSlash(path));
        if ((resource as { resourceType?: string }).resourceType !== "Bundle") {
            throw new InvalidRequestError(`Expected Bundle response for ${path}`);
        }
        return resource as unknown as fhir4.Bundle;
    }

    async patchResource(path: string, jsonPatch: string): Promise<void> {
        const { resourceType, resourceId } = parseResourcePathOrFail(path);
        const parsed = JSON.parse(jsonPatch) as unknown;
        if (!Array.isArray(parsed)) {
            throw new InvalidRequestError("JSON Patch payload must be an array");
        }
        await this.authorize();
        await this.client.patch({
            resourceType,
            id: resourceId,
            jsonPatch: parsed as OpPatch[],
        });
    }

    async postResource(resource: fhir4.Resource): Promise<fhir4.Resource> {
        await this.authorize();
        const created = await this.client.create({
            resourceType: resource.resourceType,
            body: resource as never,
        });
        return created as fhir4.Resource;
    }
}
