import { randomBytes } from "node:crypto";

import type {
    BoundLaunchContext,
    CreatedLaunchContext,
    CreateLaunchContextInput,
    LaunchContextStore,
} from "../types/launch-context-store";

/** launch id 的位元組長度；base64url 後 43 個字元，不含任何可推導的結構。 */
const LAUNCH_ID_BYTES = 32;

type UnboundRecord = {
    patientId: string;
    encounterId?: string;
    expiresAt: number;
};

/**
 * `(subject, client id)` 索引鍵的分隔符；用 IdP 不會發出的控制字元，避免拼接歧義
 * （"ab"+"c" 與 "a"+"bc" 不能撞成同一筆）。
 */
const BINDING_KEY_SEPARATOR = "\u0000";

/**
 * In-memory 的 launch context store：供測試與單機開發使用，讓測試不必依賴
 * Valkey 或 docker。正式環境的 Valkey 實作會走同一條介面。
 *
 * 這份 context 暫時還沒有被授權層讀取——它只是存在那裡等著被綁定。
 * In-memory store used by tests and single-machine development; no docker required.
 */
export class InMemoryLaunchContextStore implements LaunchContextStore {
    private readonly unbound = new Map<string, UnboundRecord>();
    private readonly bound = new Map<string, BoundLaunchContext>();
    private readonly now: () => number;

    /**
     * @param now 可注入的時鐘來源，供測試驗證 TTL 邊界；正式環境走系統時間。
     *            Injectable clock so TTL boundaries can be exercised without waiting.
     */
    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    async create(input: CreateLaunchContextInput): Promise<CreatedLaunchContext> {
        const now = this.now();
        // 未綁定 context 過期就清掉，避免 map 隨 EHR 的註冊量無限成長。
        for (const [launchId, record] of this.unbound) {
            if (record.expiresAt <= now) {
                this.unbound.delete(launchId);
            }
        }

        const expiresAt = now + input.ttlSeconds * 1000;
        const launchId = randomBytes(LAUNCH_ID_BYTES).toString("base64url");
        this.unbound.set(launchId, {
            patientId: input.patientId,
            expiresAt,
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

        const key = `${subject}${BINDING_KEY_SEPARATOR}${clientId}`;
        // 單次可用：launch id 已經綁給這組鍵時，既有綁定不動。
        if (this.bound.has(key)) {
            return undefined;
        }

        const bound: BoundLaunchContext = {
            launchId,
            subject,
            clientId,
            patientId: record.patientId,
            boundAt: this.now(),
            ...(record.encounterId !== undefined ? { encounterId: record.encounterId } : {}),
        };
        this.unbound.delete(launchId);
        this.bound.set(key, bound);

        return bound;
    }

    async get(subject: string, clientId: string): Promise<BoundLaunchContext | undefined> {
        return this.bound.get(`${subject}${BINDING_KEY_SEPARATOR}${clientId}`);
    }

    async delete(subject: string, clientId: string): Promise<boolean> {
        return this.bound.delete(`${subject}${BINDING_KEY_SEPARATOR}${clientId}`);
    }
}
