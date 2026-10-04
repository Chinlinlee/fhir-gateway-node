import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { INTERNAL_LAUNCH_API_PREFIX, LAUNCH_CONTEXTS_PATH } from "../../constants/routes";
import type { LaunchContextStore } from "../../types/launch-context-store";

/** 認證用的 request header；刻意不用 `Authorization`，讓 EHR 服務帳號與臨床使用者的 bearer token 不會混在一起。 */
export const INTERNAL_CREDENTIAL_HEADER = "x-internal-credential";

/** 內部端點需要的設定值；由 route 在 app 建構時解析好傳進來。 */
export type InternalLaunchDeps = {
    /** 內部認證憑證；與 patient-facing bearer token 完全分開。 */
    credential: string;
    /** 未綁定 launch context 的 TTL（秒）。 */
    ttlSeconds: number;
    store: LaunchContextStore;
};

const RegisterLaunchContextBodySchema = z.object({
    patientId: z.string().trim().min(1),
    encounterId: z.string().trim().min(1).optional(),
});

function jsonError(status: number, message: string): Response {
    return Response.json({ error: message }, { status });
}

/**
 * 存取與錯誤記錄只寫 method／path／status：病人、就診與嘗試用的憑證都不進日誌。
 * Access and error records carry method, path and status only — never PHI or the credential.
 */
function logOutcome(status: number): void {
    console.log(`[internal-launch] ${status} POST ${INTERNAL_LAUNCH_API_PREFIX}${LAUNCH_CONTEXTS_PATH}`);
}

/**
 * 定長比較兩個憑證：先雜湊再 `timingSafeEqual`，讓比較的時間不洩漏共同前綴長度。
 * Constant-time credential comparison; hashing first keeps both operands the same length.
 */
function credentialMatches(presented: string, expected: string): boolean {
    const presentedDigest = createHash("sha256").update(presented).digest();
    const expectedDigest = createHash("sha256").update(expected).digest();
    return timingSafeEqual(presentedDigest, expectedDigest);
}

export abstract class InternalLaunchController {
    /**
     * EHR 在「從某位病人的頁面開啟 SMART App」之前呼叫這裡，取得一份尚未綁定到任何使用者的
     * launch context 與 gateway 生成的 opaque launch id，之後當 `authorize` 的 `launch` 參數。
     *
     * 認證是設定的內部憑證，與 patient-facing bearer token 完全分開。
     * Registers a launch context and returns the gateway-generated opaque launch id plus its expiry.
     *
     * PHI（patient／encounter）只進 store，不寫進應用日誌；錯誤訊息一律是固定字串。
     */
    static async register(request: Request, deps: InternalLaunchDeps): Promise<Response> {
        const credential = request.headers.get(INTERNAL_CREDENTIAL_HEADER);
        if (credential === null || !credentialMatches(credential, deps.credential)) {
            // 不記錄嘗試用的憑證本身。
            logOutcome(401);
            return jsonError(401, "Invalid internal launch API credential");
        }

        let payload: unknown;
        try {
            payload = await request.json();
        } catch {
            logOutcome(400);
            return jsonError(400, "Request body must be JSON");
        }

        const parsed = RegisterLaunchContextBodySchema.safeParse(payload);
        if (!parsed.success) {
            logOutcome(400);
            return jsonError(400, "patientId is required; encounterId is optional");
        }

        const created = await deps.store.create({
            patientId: parsed.data.patientId,
            ttlSeconds: deps.ttlSeconds,
            ...(parsed.data.encounterId !== undefined ? { encounterId: parsed.data.encounterId } : {}),
        });

        logOutcome(201);
        return Response.json(
            {
                launchId: created.launchId,
                expiresAt: new Date(created.expiresAt).toISOString(),
                expiresInSeconds: deps.ttlSeconds,
            },
            { status: 201 },
        );
    }
}
