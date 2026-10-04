import { randomBytes } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

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
 * Valkey 實作的 launch context store：正式環境的預期選擇。
 *
 * 綁定活得比 process 久，因此 gateway 重啟不會讓進行中的 launch 失效，多個 instance 之間
 * 也看得見彼此的綁定（ADR-0002）。
 *
 * **正式環境的連線必須加密且有認證**：store 裡放著病人與就診參照（PHI）。
 * Valkey-backed store: bindings survive restarts and are visible across instances. The
 * connection carries PHI, so TLS and credentials are a production requirement.
 */

/** Valkey 內本專案使用的 key 前綴。固定值而不是設定值：各 instance 填不同的前綴會讓彼此看不見。 */
export const LAUNCH_CONTEXT_KEY_PREFIX = "fhir-gateway:launch-context";

const unboundKey = (launchId: string): string => `${LAUNCH_CONTEXT_KEY_PREFIX}:unbound:${launchId}`;
// 綁定事實以 launch id 存放（launch id 單次可用，因此天然唯一且不會被改寫）。access token 的
// 索引指向這裡，而不是 `(subject, client id)`——否則醫師再 launch 一次就會把已經發出去的
// token 改指向另一位病人。
const boundKey = (launchId: string): string => `${LAUNCH_CONTEXT_KEY_PREFIX}:bound:${launchId}`;
// `(subject, client id)` → 目前綁到哪一次 launch。粗鍵，會被後來的 launch 移動。
const bindingIndexKey = (subject: string, clientId: string): string =>
    `${LAUNCH_CONTEXT_KEY_PREFIX}:binding-index:${launchContextBindingKey(subject, clientId)}`;
const bindingTokensKey = (launchId: string): string => `${LAUNCH_CONTEXT_KEY_PREFIX}:binding-tokens:${launchId}`;
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
 * 綁定的 script：確認未綁定 context 還在，把欄位搬進以 launch id 為鍵的綁定記錄、設上綁定 TTL，
 * 更新 `(subject, client id)` 的索引，然後刪掉未綁定那份——四件事必須是同一個原子操作。
 *
 * 索引是**覆寫**而不是拒絕：一位醫師看完病人 A 再從病人 B 的頁面開同一個 App 是 EHR 的日常。
 * 已經發出去的 access token 各自指向自己的 launch id，因此這次覆寫不會動到它們。
 */
const BIND_SCRIPT = `
local launchId = redis.call('HGET', KEYS[1], 'launchId')
if not launchId then
    return nil
end
local patientId = redis.call('HGET', KEYS[1], 'patientId')
local patientListId = redis.call('HGET', KEYS[1], 'patientListId')
local encounterId = redis.call('HGET', KEYS[1], 'encounterId')
redis.call('HSET', KEYS[2], 'launchId', launchId, 'subject', ARGV[1], 'clientId', ARGV[2], 'boundAt', ARGV[3])
if patientId then redis.call('HSET', KEYS[2], 'patientId', patientId) end
if patientListId then redis.call('HSET', KEYS[2], 'patientListId', patientListId) end
if encounterId then redis.call('HSET', KEYS[2], 'encounterId', encounterId) end
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
redis.call('SET', KEYS[3], launchId, 'EX', tonumber(ARGV[4]))
redis.call('DEL', KEYS[1])
return launchId
`;

/**
 * 接上 access token 的 script：綁定還在（沒到期、沒被刪）才接。
 * 沒有綁定的 access token 在授權層本來就會被拒絕，留下索引只是浪費。
 *
 * 索引的值是 launch id，因此這張 token 的解析結果**不會**因為這位醫師之後再 launch 一次而改變。
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
local launchId = redis.call('GET', KEYS[1])
if not launchId then
    return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
local tokenIds = redis.call('SMEMBERS', KEYS[3])
for index = 1, #tokenIds do
    redis.call('DEL', ARGV[1] .. tokenIds[index])
end
redis.call('DEL', KEYS[3])
return 1
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
    private readonly boundTtlSeconds: number;

    /**
     * @param client 已（或即將）連上 Valkey 的 client；啟動時的連線與重試由
     *               `createLaunchContextStore` 負責，這裡只負責資料。
     * @param now 可注入的時鐘來源，供測試驗 TTL 邊界；正式環境走系統時間。
     * @param boundTtlSeconds 綁定後的存活秒數（ADR-0004）；到期由 Valkey 的 EXPIRE 收。
     */
    constructor(
        private readonly client: ValkeyStoreClient,
        now: () => number = () => Date.now(),
        boundTtlSeconds: number = DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS,
    ) {
        this.now = now;
        this.boundTtlSeconds = boundTtlSeconds;
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
        const launched = await this.client.eval(BIND_SCRIPT, {
            keys: [unboundKey(launchId), boundKey(launchId), bindingIndexKey(subject, clientId)],
            arguments: [subject, clientId, String(this.now()), String(this.boundTtlSeconds)],
        });
        // 未知 id、已過期的 id、以及已被綁定的 id，對呼叫端都是同一件事：綁不上。
        if (typeof launched !== "string") {
            return undefined;
        }

        return await this.readBinding(launchId);
    }

    async attachAccessToken(tokenId: string, launchId: string): Promise<void> {
        await this.client.eval(ATTACH_SCRIPT, {
            keys: [boundKey(launchId), tokenKey(tokenId), bindingTokensKey(launchId)],
            arguments: [launchId, tokenId],
        });
    }

    async getByAccessToken(tokenId: string): Promise<BoundLaunchContext | undefined> {
        const launchId = await this.client.get(tokenKey(tokenId));
        // 綁定過期或被刪時 `bound:` 這筆已不存在，`readBinding` 因此回 `undefined`——
        // 到期等同查無，患者／清單模式因此是 401。
        return launchId === null ? undefined : await this.readBinding(launchId);
    }

    async get(subject: string, clientId: string): Promise<BoundLaunchContext | undefined> {
        const launchId = await this.client.get(bindingIndexKey(subject, clientId));
        return launchId === null ? undefined : await this.readBinding(launchId);
    }

    async delete(subject: string, clientId: string): Promise<boolean> {
        const launchId = await this.client.get(bindingIndexKey(subject, clientId));
        if (launchId === null) {
            return false;
        }

        const removed = await this.client.eval(DELETE_SCRIPT, {
            keys: [bindingIndexKey(subject, clientId), boundKey(launchId), bindingTokensKey(launchId)],
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

    private async readBinding(launchId: string): Promise<BoundLaunchContext | undefined> {
        const fields = await this.client.hGetAll(boundKey(launchId));
        // Valkey 對不存在的 key 回空物件，正好是「沒有綁定」——過期的綁定也走這一條。
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
