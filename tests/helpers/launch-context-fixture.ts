import type { JWTPayload } from "jose";

import { DefaultLaunchContextProvider } from "../../src/services/launch-context.service";
import { InMemoryLaunchContextStore } from "../../src/services/launch-context-store.service";
import type { LaunchContext } from "../../src/types/launch-context";
import type { LaunchContextStore } from "../../src/types/launch-context-store";

/** 這組 fixture 用的假 launch id 與 token id；內容對測試不重要，只有「一致」才重要。 */
const FIXTURE_SUBJECT = "fixture-clinician";
const FIXTURE_CLIENT_ID = "fixture-app";
const FIXTURE_TOKEN_ID = "fixture-token-id";

/**
 * 由 token claims 建立 LaunchContext；走真實的 provider，因此 claim 名稱與裁決來源與
 * production 一致。
 *
 * 這裡**沒有**任何 launch context 被綁定，因此 `patientId`／`patientListId` 一定是
 * `undefined`——這正是「沒有 launch context」在授權層的樣子。
 *
 * Builds a LaunchContext through the real provider, with nothing bound in the store.
 */
export async function launchContextFromClaims(claims: JWTPayload = {}): Promise<LaunchContext> {
    return await new DefaultLaunchContextProvider(new InMemoryLaunchContextStore()).create({
        payload: claims,
        protectedHeader: { alg: "RS256" },
    });
}

/**
 * 先在 store 裡建立並綁定一份 launch context，再由**真實的** provider 轉譯出 LaunchContext。
 * 測試因此仍然在驗「裁決來源是 store」，而不是自己拼一份 DTO。
 *
 * Binds a launch context in a store first, then lets the real provider read it back.
 */
export async function launchContextWithPatient(patientId: string, claims: JWTPayload = {}): Promise<LaunchContext> {
    const store = new InMemoryLaunchContextStore();
    const created = await store.create({ patientId, ttlSeconds: 300 });
    await store.bind(created.launchId, FIXTURE_SUBJECT, FIXTURE_CLIENT_ID);
    await store.attachAccessToken(FIXTURE_TOKEN_ID, created.launchId);

    return await new DefaultLaunchContextProvider(store).create({
        payload: { sub: FIXTURE_SUBJECT, jti: FIXTURE_TOKEN_ID, ...claims },
        protectedHeader: { alg: "RS256" },
    });
}

/**
 * 在 store 裡建立並綁定一份 launch context，並把它接到指定的 access token 上。
 *
 * 給「自己簽 token、不走代理流程」的 app-over-HTTP 測試用：token 必須帶著這裡的 `tokenId`
 * （JWT `jti`）與 `subject`，gateway 才認得出這次授權綁的是誰。
 *
 * Seeds a launch context in the store and attaches it to a token the test signed itself.
 */
export async function seedLaunchContextForToken(
    store: LaunchContextStore,
    binding: { subject: string; clientId: string; tokenId: string },
    launch: { patientId?: string; patientListId?: string },
): Promise<void> {
    const target =
        launch.patientId !== undefined
            ? { patientId: launch.patientId }
            : { patientListId: launch.patientListId ?? "" };
    const created = await store.create({ ttlSeconds: 300, ...target });
    await store.bind(created.launchId, binding.subject, binding.clientId);
    await store.attachAccessToken(binding.tokenId, created.launchId);
}

/**
 * store 故障的形狀：每個方法都以連線錯誤收場。
 *
 * 授權層必須在這個情況下 fail closed——`patient`／`list` 模式 401，而不需要 launch context
 * 的模式照常服務。
 */
export function unreachableLaunchContextStore(): LaunchContextStore {
    const fail = async (): Promise<never> => {
        throw new Error("launch context store is unreachable");
    };
    return {
        create: fail,
        isAvailable: fail,
        bind: fail,
        attachAccessToken: fail,
        getByAccessToken: fail,
        get: fail,
        delete: fail,
    };
}
