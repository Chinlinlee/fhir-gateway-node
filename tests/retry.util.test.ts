import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    buildRetryDelaysMs,
    retryWithDelays,
    STARTUP_FETCH_RETRY_BASE_DELAY_MS,
    STARTUP_FETCH_RETRY_COUNT,
    STARTUP_FETCH_RETRY_DELAYS_MS,
    sleep,
} from "../src/utils/retry.util";

describe("retryWithDelays", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("returns on first success", async () => {
        const fn = vi.fn().mockResolvedValue("ok");
        await expect(retryWithDelays(fn, [10, 20])).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries with configured delays then succeeds", async () => {
        const fn = vi
            .fn()
            .mockRejectedValueOnce(new Error("fetch failed"))
            .mockRejectedValueOnce(new Error("fetch failed"))
            .mockResolvedValue("ok");
        const onRetry = vi.fn();

        const promise = retryWithDelays(fn, [100, 200], onRetry);

        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(200);

        await expect(promise).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledTimes(3);
        expect(onRetry).toHaveBeenCalledTimes(2);
        expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 100 });
        expect(onRetry.mock.calls[1]?.[0]).toMatchObject({ attempt: 2, delayMs: 200 });
    });

    it("throws last error after max attempts", async () => {
        const fn = vi.fn().mockRejectedValue(new Error("fetch failed"));
        const promise = retryWithDelays(fn, [50]);

        const assertion = expect(promise).rejects.toThrow("fetch failed");
        await vi.advanceTimersByTimeAsync(50);
        await assertion;
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it("buildRetryDelaysMs — linear from base (3s → 9s)", () => {
        expect(buildRetryDelaysMs(3000, 3)).toEqual([3000, 6000, 9000]);
        expect(STARTUP_FETCH_RETRY_DELAYS_MS).toEqual(buildRetryDelaysMs());
        expect(STARTUP_FETCH_RETRY_BASE_DELAY_MS).toBe(3000);
        expect(STARTUP_FETCH_RETRY_COUNT).toBe(3);
    });
});

describe("sleep", () => {
    it("resolves after delay", async () => {
        vi.useFakeTimers();
        const promise = sleep(500);
        await vi.advanceTimersByTimeAsync(500);
        await expect(promise).resolves.toBeUndefined();
        vi.useRealTimers();
    });
});
