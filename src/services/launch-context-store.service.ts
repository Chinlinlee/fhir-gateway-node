import { randomBytes } from "node:crypto";

import { DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS } from "../constants/config";
import { LAUNCH_ID_BYTES } from "../constants/launch-context";
import type {
    BoundLaunchContext,
    CreatedLaunchContext,
    CreateLaunchContextInput,
    LaunchContextStore,
} from "../types/launch-context-store";
import { launchContextBindingKey } from "./launch-context-store-key";

/**
 * In-memory 的 launch context store：供測試與單機開發使用，讓測試不必依賴
 * Valkey 或 docker。正式環境的 Valkey 實作走同一條介面。
 *
 * In-memory store used by tests and single-machine development; no docker required.
 *
 * **不適合正式環境**：綁定只活在這個 process 的記憶體裡——gateway 重啟會讓所有進行中的
 * launch 全部失效，多個 instance 之間也看不到彼此的綁定。正式環境請設
 * `LAUNCH_CONTEXT_STORE=valkey`（見 `ValkeyLaunchContextStore`）。
 * Not for production: bindings die with the process and are invisible to other instances.
 */
export class InMemoryLaunchContextStore implements LaunchContextStore {
    private readonly unbound = new Map<string, UnboundRecord>();
    /** 綁定事實本身，以 launch id 存放：launch id 單次可用，因此它天然唯一且不會被改寫。 */
    private readonly bound = new Map<string, BoundRecord>();
    /** `(subject, client id)` → 這組鍵目前指向哪一次 launch。粗鍵，會被後來的 launch 移動。 */
    private readonly bindingIndex = new Map<string, string>();
    /** access token 的 `jti` → 它被發放時所屬的那一次 launch（launch id）。 */
    private readonly accessTokens = new Map<string, string>();
    private readonly now: () => number;
    private readonly boundTtlSeconds: number;

    /**
     * @param now 可注入的時鐘來源，供測試驗證 TTL 邊界；正式環境走系統時間。
     *            Injectable clock so TTL boundaries can be exercised without waiting.
     * @param boundTtlSeconds 綁定後的存活秒數（ADR-0004：一位醫師處理同一位病人的時長上限）。
     */
    constructor(now: () => number = () => Date.now(), boundTtlSeconds = DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS) {
        this.now = now;
        this.boundTtlSeconds = boundTtlSeconds;
    }

    async create(input: CreateLaunchContextInput): Promise<CreatedLaunchContext> {
        const now = this.now();
        // 過期的記錄順手清掉，避免 map 隨 EHR 的註冊量無限成長。
        this.purgeExpired(now);

        const expiresAt = now + input.ttlSeconds * 1000;
        const launchId = randomBytes(LAUNCH_ID_BYTES).toString("base64url");
        this.unbound.set(launchId, {
            expiresAt,
            ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
            ...(input.patientListId !== undefined ? { patientListId: input.patientListId } : {}),
            ...(input.encounterId !== undefined ? { encounterId: input.encounterId } : {}),
        });

        return { launchId, expiresAt };
    }

    async isAvailable(launchId: string): Promise<boolean> {
        const record = this.unbound.get(launchId);
        return record !== undefined && record.expiresAt > this.now();
    }

    async bind(launchId: string, subject: string, clientId: string): Promise<BoundLaunchContext | undefined> {
        const record = this.unbound.get(launchId);
        // 未知 id、已過期的 id、以及已被綁定的 id，對呼叫端都是同一件事：綁不上。
        if (record === undefined || record.expiresAt <= this.now()) {
            return undefined;
        }

        const context: BoundLaunchContext = {
            launchId,
            subject,
            clientId,
            boundAt: this.now(),
            ...(record.patientId !== undefined ? { patientId: record.patientId } : {}),
            ...(record.patientListId !== undefined ? { patientListId: record.patientListId } : {}),
            ...(record.encounterId !== undefined ? { encounterId: record.encounterId } : {}),
        };
        this.unbound.delete(launchId);
        this.bound.set(launchId, { context, expiresAt: this.now() + this.boundTtlSeconds * 1000 });
        // 這組鍵「目前」指向這次 launch。一位醫師看完病人 A 再從病人 B 的頁面開同一個 App，
        // 是 EHR 的日常而不是例外，因此重新綁定是允許的。已經發出去的 access token 不受影響：
        // 它們各自記著自己那一次 launch 的 launch id，不是這組粗鍵。
        this.bindingIndex.set(launchContextBindingKey(subject, clientId), launchId);

        return context;
    }

    async attachAccessToken(tokenId: string, launchId: string): Promise<void> {
        // 沒有綁定就不接：沒有綁定的 access token 在授權層本來就會被拒絕。
        if (this.bound.has(launchId)) {
            this.accessTokens.set(tokenId, launchId);
        }
    }

    async getByAccessToken(tokenId: string): Promise<BoundLaunchContext | undefined> {
        const launchId = this.accessTokens.get(tokenId);
        return launchId === undefined ? undefined : this.readBinding(launchId);
    }

    private readBinding(launchId: string): BoundLaunchContext | undefined {
        const record = this.bound.get(launchId);
        if (record === undefined) {
            return undefined;
        }
        if (record.expiresAt <= this.now()) {
            this.bound.delete(launchId);
            return undefined;
        }
        return record.context;
    }

    private purgeExpired(now: number): void {
        for (const [launchId, record] of this.unbound) {
            if (record.expiresAt <= now) {
                this.unbound.delete(launchId);
            }
        }
        for (const [launchId, record] of this.bound) {
            if (record.expiresAt <= now) {
                this.bound.delete(launchId);
                for (const [tokenId, boundLaunchId] of this.accessTokens) {
                    if (boundLaunchId === launchId) {
                        this.accessTokens.delete(tokenId);
                    }
                }
            }
        }
    }
}

type UnboundRecord = {
    patientId?: string;
    patientListId?: string;
    encounterId?: string;
    expiresAt: number;
};

type BoundRecord = {
    context: BoundLaunchContext;
    expiresAt: number;
};
