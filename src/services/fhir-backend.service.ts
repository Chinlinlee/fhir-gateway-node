/// <reference types="fhir" />

import type { OpPatch, RequestOptions } from "fhir-kit-client";

import { BEARER_PREFIX } from "../constants/auth";
import { BackendCredentialError } from "../errors/backend-credential.error";
import { InvalidRequestError } from "../errors/invalid-request.error";
import { createFhirKitClient, type FhirKitClient } from "../utils/fhir-kit-client.util";
import { formatErrorMessage } from "../utils/format-error.util";

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

    /**
     * 每個請求自帶的 backend 憑證。
     *
     * `fhir-kit-client` 的 `Client` 只有 instance 層級的 `bearerToken`，在共用的 client 上寫入
     * 等於讓所有請求共用同一份可變狀態；改以 per-request header 帶入，授權路徑上不留跨請求狀態。
     * 憑證取得失敗是 gateway 自己的故障，一律轉成 `BackendCredentialError`（對外 5xx），
     * 原始錯誤只寫進 server log。
     */
    private async backendRequestOptions(): Promise<RequestOptions> {
        if (!this.getBearerToken) {
            return {};
        }

        let token: string;
        try {
            token = await this.getBearerToken();
        } catch (error) {
            if (error instanceof BackendCredentialError) {
                // provider 已經記錄過原始原因，這裡只負責把它升級成 backend 憑證故障。
                throw error;
            }
            console.error(`[fhir-backend] cannot resolve the FHIR backend credential: ${formatErrorMessage(error)}`);
            throw new BackendCredentialError(error);
        }

        return { headers: { authorization: `${BEARER_PREFIX}${token}` } };
    }

    /** backend 查詢與 AuditEvent 寫入都走同一組憑證，與轉發用的一致。 */
    async getResource(path: string): Promise<fhir4.Bundle> {
        const resource = await this.client.request(trimLeadingSlash(path), {
            options: await this.backendRequestOptions(),
        });
        // FhirResource 已宣告 resourceType: string，不需再斷言一次形狀。
        if (resource.resourceType !== "Bundle") {
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
        await this.client.patch({
            resourceType,
            id: resourceId,
            jsonPatch: parsed as OpPatch[],
            options: await this.backendRequestOptions(),
        });
    }

    async postResource(resource: fhir4.Resource): Promise<fhir4.Resource> {
        const created = await this.client.create({
            resourceType: resource.resourceType,
            body: resource as never,
            options: await this.backendRequestOptions(),
        });
        return created as fhir4.Resource;
    }
}
