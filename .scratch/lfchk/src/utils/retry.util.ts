/** 首次重試前等待基準（ms）；第 n 次重試前等待 = base × n */
export const STARTUP_FETCH_RETRY_BASE_DELAY_MS = 3000;

/** 重試次數（不含首次請求） */
export const STARTUP_FETCH_RETRY_COUNT = 3;

export function buildRetryDelaysMs(
    baseDelayMs: number = STARTUP_FETCH_RETRY_BASE_DELAY_MS,
    retryCount: number = STARTUP_FETCH_RETRY_COUNT,
): number[] {
    return Array.from({ length: retryCount }, (_, index) => baseDelayMs * (index + 1));
}

/** 啟動 fetch 重試間隔（例：3000 → 6000） */
export const STARTUP_FETCH_RETRY_DELAYS_MS = buildRetryDelaysMs();

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function startupFetchMaxAttempts(): number {
    return STARTUP_FETCH_RETRY_COUNT + 1;
}

export async function retryWithDelays<T>(
    fn: () => Promise<T>,
    delaysMs: readonly number[] = STARTUP_FETCH_RETRY_DELAYS_MS,
    onRetry?: (context: { attempt: number; maxAttempts: number; error: unknown; delayMs: number }) => void,
): Promise<T> {
    const maxAttempts = delaysMs.length + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt >= maxAttempts) {
                break;
            }
            const delayMs = delaysMs[attempt - 1] ?? delaysMs[delaysMs.length - 1]!;
            onRetry?.({ attempt, maxAttempts, error, delayMs });
            await sleep(delayMs);
        }
    }

    throw lastError;
}
