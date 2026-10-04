import type { GatewayConfig } from "../configs/env.schema";
import { DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS, DEFAULT_LAUNCH_CONTEXT_STORE, ENV_KEYS } from "../constants/config";
import { StartupConnectionError } from "../errors/startup-connection.error";
import type { LaunchContextStore } from "../types/launch-context-store";
import { formatErrorMessage } from "../utils/format-error.util";
import { retryWithDelays, startupFetchMaxAttempts } from "../utils/retry.util";
import { InMemoryLaunchContextStore } from "./launch-context-store.service";
import { createValkeyClient, ValkeyLaunchContextStore } from "./valkey-launch-context-store.service";

/** 只調整重試間隔的重試選項；給測試用，讓「連不上」不必真的等 18 秒。 */
export type CreateLaunchContextStoreOptions = {
    /** 每次重試前的等待（毫秒）；未給時沿用啟動 fetch 的間隔。 */
    retryDelaysMs?: readonly number[];
};

/**
 * 依設定建立 launch context store，這是 production 的唯一來源。
 *
 * **選 valkey 時連線失敗就讓啟動失敗**，行為與連 IdP 失敗一致：store 對 patient／list 模式
 * 等同 401，讓一個連不上的 store 開著，比明確失敗危險得多（醫師會在沒有預警的情況下被拒絕）。
 *
 * Builds the configured launch context store, failing startup when the chosen store is unreachable.
 */
export async function createLaunchContextStore(
    config: GatewayConfig,
    options: CreateLaunchContextStoreOptions = {},
): Promise<LaunchContextStore> {
    if ((config.launchContextStoreType ?? DEFAULT_LAUNCH_CONTEXT_STORE) !== "valkey") {
        warnInMemoryStoreIsNotForProduction(config);
        return new InMemoryLaunchContextStore(
            () => Date.now(),
            config.launchContextBoundTtlSeconds ?? DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS,
        );
    }

    // `parseLaunchContextValkeyUrl` 已經擋掉「選 valkey 卻沒給 URL」；這裡是型別上的收斂。
    const url = config.launchContextValkeyUrl;

    if (url === undefined) {
        throw new StartupConnectionError(
            ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL,
            "",
            new Error(`${ENV_KEYS.LAUNCH_CONTEXT_STORE}=valkey needs ${ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL}`),
            0,
        );
    }

    const client = createValkeyClient(url);
    const delaysMs = options.retryDelaysMs;
    const maxAttempts = startupFetchMaxAttempts();

    try {
        await retryWithDelays(
            async () => {
                await client.connect();
            },
            delaysMs,
            ({ attempt, maxAttempts: total, error, delayMs }) => {
                console.warn(
                    `Cannot connect to '${ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL}' at ${redactUrlCredentials(url)} (attempt ${attempt}/${total}): ${formatErrorMessage(error)}. Retrying in ${delayMs / 1000}s...`,
                );
            },
        );
    } catch (error) {
        // 連線 URL 裡帶著 store 的認證憑證，錯誤訊息不得把它原樣印出來。
        throw new StartupConnectionError(
            ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL,
            redactUrlCredentials(url),
            error,
            delaysMs === undefined ? maxAttempts : delaysMs.length + 1,
        );
    }

    return new ValkeyLaunchContextStore(
        client,
        () => Date.now(),
        config.launchContextBoundTtlSeconds ?? DEFAULT_LAUNCH_CONTEXT_BOUND_TTL_SECONDS,
    );
}

/**
 * in-memory store 在正式環境是錯的選擇：多 instance 之間看不到彼此的綁定，重啟也會讓所有
 * 進行中的 launch 失效。因此 PROD 下明確說出來——與 `TOKEN_AUDIENCE` 的 PROD 警告同一個理由。
 */
function warnInMemoryStoreIsNotForProduction(config: GatewayConfig): void {
    if (config.runMode !== "PROD") {
        return;
    }
    console.warn(
        `${ENV_KEYS.LAUNCH_CONTEXT_STORE}=memory is not suitable for production: launch context bindings do not survive a gateway restart and are invisible to other gateway instances. Set ${ENV_KEYS.LAUNCH_CONTEXT_STORE}=valkey with ${ENV_KEYS.LAUNCH_CONTEXT_VALKEY_URL}.`,
    );
}

/** 只留下 host/port/path；使用者名稱與密碼換成 `***`，不進任何 log。 */
function redactUrlCredentials(url: string): string {
    try {
        const parsed = new URL(url);
        if (parsed.username === "" && parsed.password === "") {
            return url;
        }
        parsed.username = "***";
        parsed.password = "***";
        return parsed.toString();
    } catch {
        // 不是合法 URL：寧可什麼都不顯示，也不要猜。
        return "<redacted>";
    }
}
