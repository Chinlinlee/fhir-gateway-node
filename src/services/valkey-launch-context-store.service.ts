import { randomBytes } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

import type {
    BoundLaunchContext,
    CreatedLaunchContext,
    CreateLaunchContextInput,
    LaunchContextStore,
} from "../types/launch-context-store";
import { launchContextBindingKey } from "./launch-context-store-key";

/**
 * Valkey 實作的 launch context store：正式環境的預期選擇。
 *
 * **為什麼正式環境必須是它**（ADR-0002）：綁定要活得比 gateway process 久。
 * In-memory 的話，一次部署重啟就讓所有進行中的 launch 全部失效（正在處理病人的醫師會突然
 * 拿到 401），多個 instance 之間也看不到彼此的綁定。
 *
 * **store 裡放著什麼**：病人與就診參照（PHI），以及一組 access token 的 `jti` → 綁定索引——
 * 後者足以把 IdP 簽出的 token 對回這次授權。因此 store 的連線本身需要 TLS 與認證，
 * 見 README 的「Launch context store（Valkey）」。
 *
 * **鍵的形狀**（全部帶前綴，方便與同一個 Valkey 上的其他資料分辨）：
 * - `…:unbound:<launch id>`：尚未綁定的 launch context，hash，帶 TTL。過期由 Valkey 收掉，
 *   因此不會留下任何還能綁定的資料。
 * - `…:binding:<(subject, client id)>`：綁定後的 launch context，hash，**沒有 TTL**
 *   （綁定後的生命週期屬於 ADR-0004，尚未實作）。
 * - `…:token:<jti>`：這張 access token 屬於哪一筆綁定，值直接是綁定的儲存鍵。
 * - `…:binding:<(subject, client id)>:tokens`：指向同一筆綁定的所有 `jti`，
 *   讓刪除綁定時能一併讓那些 token 查不到。
 *
 * Shared Valkey-backed store; the in-memory implementation stays the test/dev default.
 */

/** Valkey 內本專案使用的 key 前綴。固定值而不是設定值：各 instance 填不同的前綴會讓彼此看不見。 */
export const LAUNCH_CONTEXT_KEY_PREFIX = "fhir-gateway:launch-context";

/** launch id 的位元組長度；base64url 後 43 個字元，不含任何可推導的結構。 */
const LAUNCH_ID_BYTES = 32;

const unboundKey = (launchId: string): string => `${LAUNCH_CONTEXT_KEY_PREFIX}:unbound:${launchId}`;
const bindingKey = (subject: string, clientId: string): string =>
    `${LAUNCH_CONTEXT_KEY_PREFIX}:binding:${launchContextBindingKey(subject, clientId)}`;
// 三種 key 用不同的第三段（`unbound:`／`binding:`／`binding-tokens:`），因此 client id 再怎麼
// 湊巧含有這些字串都不會撞到另一種 key。`\0` 分隔的 binding 鍵本身也只出現在段的最後。
const bindingTokensKey = (subject: string, clientId: string): string =>
    `${LAUNCH_CONTEXT_KEY_PREFIX}:binding-tokens:${launchContextBindingKey(subject, clientId)}`;
const tokenKey = (tokenId: string): string => `${LAUNCH_CONTEXT_KEY_PREFIX}:token:${tokenId}`;

/**
 * 建立未綁定 context 的 script：寫入欄位並在**同一個**原子操作裡設 TTL。
 * 分兩次呼叫（HMSET 再 EXPIRE）會在中間 crash 時留下一筆永不過期的未綁定 context——
 * 那等於一組永遠可被綁定的 launch id。
 */
const CREATE_SCRIPT = `
redis.call('HSET', KEYS[1], 'launchId', ARGV[1], ARGV[2], ARGV[3])
if ARGV[4] ~= '' then
    redis.call('HSET', KEYS[1], 'encounterId', ARGV[4])
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return 1
`;

/**
 * 綁定的 script：確認未綁定 context 還在、這組 `(subject, client id)` 還沒有綁定，
 * 然後把欄位搬過去並刪掉未綁定那份——三件事必須是同一個原子操作。
 * 分開做的話，兩個 instance 可以同時綁走同一個 launch id，各自寫成一筆不同的綁定。
 */
const BIND_SCRIPT = `
local launchId = redis.call('HGET', KEYS[1], 'launchId')
if not launchId then
    return nil
end
if redis.call('EXISTS', KEYS[2]) == 1 then
    return nil
end
local patientId = redis.call('HGET', KEYS[1], 'patientId')
local patientListId = redis.call('HGET', KEYS[1], 'patientListId')
local encounterId = redis.call('HGET', KEYS[1], 'encounterId')
redis.call('HSET', KEYS[2], 'launchId', launchId, 'subject', ARGV[1], 'clientId', ARGV[2], 'boundAt', ARGV[3])
if patientId then redis.call('HSET', KEYS[2], 'patientId', patientId) end
if patientListId then redis.call('HSET', KEYS[2], 'patientListId', patientListId) end
if encounterId then redis.call('HSET', KEYS[2], 'encounterId', encounterId) end
redis.call('DEL', KEYS[1])
return launchId
`;

/**
 * 接上 access token 的 script：沒有綁定就不接。
 * 沒有綁定的 access token 在授權層本來就會被拒絕，留下索引只是浪費。
 */
const ATTACH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
    return 0
end
redis.call('SET', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[2])
return 1
`;

/**
 * 刪除綁定的 script：綁定消失時，一併讓所有指向它的 access token 查不到——
 * 索引指向不存在的綁定等於查無。
 */
const DELETE_SCRIPT = `
local removed = redis.call('DEL', KEYS[1])
local tokenIds = redis.call('SMEMBERS', KEYS[2])
for index = 1, #tokenIds do
    redis.call('DEL', ARGV[1] .. tokenIds[index])
end
redis.call('DEL', KEYS[2])
return removed
`;

/**
 * 綁定後的 launch context 存成 hash；欄位缺的就是沒有。
 * `boundAt` 存成字串，讀回來時轉回數字。
 */
const BoundLaunchContextFields = z.object({
    launchId: z.string(),
    subject: z.string(),
    clientId: z.string(),
    boundAt: z.coerce.number(),
    patientId: z.string().optional(),
    patientListId: z.string().optional(),
    encounterId: z.string().optional(),
});

/**
 * 這個 store 用得到的 Valkey 指令。刻意只宣告用得到的部分：driver 換掉時受影響的只有
 * 建立 client 的那一處，store 本身不必跟著改。
 */
export type ValkeyStoreClient = {
    exists: (key: string) => Promise<number>;
    hGetAll: (key: string) => Promise<Record<string, string>>;
    get: (key: string) => Promise<string | null>;
    eval: (script: string, options: { keys: string[]; arguments: string[] }) => Promise<unknown>;
    close: () => Promise<void>;
};

/** `redis` 套件建立的 client 型別；正式環境由 `createLaunchContextStore` 產生。 */
export type ValkeyClient = RedisClientType;

/**
 * 建立一個 Valkey client。連線錯誤一律記錄但不印出連線 URL——URL 帶著 store 的認證憑證。
 * Connection errors are logged without the URL: it carries the store credential.
 */
export function createValkeyClient(url: string): ValkeyClient {
    let everConnected = false;
    const client = createClient({
        url,
        socket: {
            // 啟動時的第一次連線由 `createLaunchContextStore` 的重試迴圈負責：它會印出
            // 進度並在耗盡後指名環境變數。在這裡默默重試只會讓「連不上」變成一個安靜的延遲。
            // 連上之後的斷線則交回 node-redis 自己重連——store 中斷不等於綁定失效，
            // 但也不能讓它變成永久故障。
            reconnectStrategy: (retries: number) => (everConnected ? Math.min(retries * 200, 3000) : false),
        },
    });
    client.on("connect", () => {
        everConnected = true;
    });
    client.on("error", (error: unknown) => {
        console.error(`[launch-context] valkey connection error: ${error instanceof Error ? error.message : error}`);
    });
    return client;
}

export class ValkeyLaunchContextStore implements LaunchContextStore {
    private readonly now: () => number;

    /**
     * @param client 已（或即將）連上 Valkey 的 client；啟動時的連線與重試由
     *               `createLaunchContextStore` 負責，這裡只負責資料。
     * @param now 可注入的時鐘來源，供測試驗 TTL 邊界；正式環境走系統時間。
     */
    constructor(
        private readonly client: ValkeyStoreClient,
        now: () => number = () => Date.now(),
    ) {
        this.now = now;
    }

    async create(input: CreateLaunchContextInput): Promise<CreatedLaunchContext> {
        const ttlSeconds = input.ttlSeconds;
        const launchId = randomBytes(LAUNCH_ID_BYTES).toString("base64url");
        // patient 與 patient list 二擇一；寫成 hash 欄位名，script 才能原樣搬過去。
        const patientField = input.patientId !== undefined ? "patientId" : "patientListId";
        const patientValue = input.patientId ?? input.patientListId ?? "";

        await this.client.eval(CREATE_SCRIPT, {
            keys: [unboundKey(launchId)],
            arguments: [launchId, patientField, patientValue, input.encounterId ?? "", String(ttlSeconds)],
        });

        return { launchId, expiresAt: this.now() + ttlSeconds * 1000 };
    }

    async isAvailable(launchId: string): Promise<boolean> {
        // TTL 由 Valkey 自己收：過期的未綁定 context 不會殘留成可被綁定的資料。
        return (await this.client.exists(unboundKey(launchId))) > 0;
    }

    async bind(launchId: string, subject: string, clientId: string): Promise<BoundLaunchContext | undefined> {
        const key = bindingKey(subject, clientId);
        const launched = await this.client.eval(BIND_SCRIPT, {
            keys: [unboundKey(launchId), key],
            arguments: [subject, clientId, String(this.now())],
        });
        // 未知 id、已過期的 id、以及已被綁定的 id，對呼叫端都是同一件事：綁不上。
        if (typeof launched !== "string") {
            return undefined;
        }

        return await this.readBinding(key);
    }

    async attachAccessToken(tokenId: string, subject: string, clientId: string): Promise<void> {
        const key = bindingKey(subject, clientId);
        await this.client.eval(ATTACH_SCRIPT, {
            keys: [key, tokenKey(tokenId), bindingTokensKey(subject, clientId)],
            arguments: [key, tokenId],
        });
    }

    async getByAccessToken(tokenId: string): Promise<BoundLaunchContext | undefined> {
        const key = await this.client.get(tokenKey(tokenId));
        return key === null ? undefined : await this.readBinding(key);
    }

    async get(subject: string, clientId: string): Promise<BoundLaunchContext | undefined> {
        return await this.readBinding(bindingKey(subject, clientId));
    }

    async delete(subject: string, clientId: string): Promise<boolean> {
        const key = bindingKey(subject, clientId);
        const removed = await this.client.eval(DELETE_SCRIPT, {
            keys: [key, bindingTokensKey(subject, clientId)],
            arguments: [`${LAUNCH_CONTEXT_KEY_PREFIX}:token:`],
        });
        return typeof removed === "number" && removed > 0;
    }

    /** 釋放連線；`LaunchContextStore` 介面刻意不要求這件事，只有持有連線的實作才有。 */
    async close(): Promise<void> {
        try {
            await this.client.close();
        } catch {
            // 連線早就斷掉時 client 會再丟一次；關閉必須是冪等的，不能蓋掉真正的呼叫失敗。
        }
    }

    private async readBinding(key: string): Promise<BoundLaunchContext | undefined> {
        const fields = await this.client.hGetAll(key);
        // Valkey 對不存在的 key 回空物件，正好是「沒有綁定」。
        if (Object.keys(fields).length === 0) {
            return undefined;
        }
        const parsed = BoundLaunchContextFields.parse(fields);
        return {
            launchId: parsed.launchId,
            subject: parsed.subject,
            clientId: parsed.clientId,
            boundAt: parsed.boundAt,
            ...(parsed.patientId !== undefined ? { patientId: parsed.patientId } : {}),
            ...(parsed.patientListId !== undefined ? { patientListId: parsed.patientListId } : {}),
            ...(parsed.encounterId !== undefined ? { encounterId: parsed.encounterId } : {}),
        };
    }
}
