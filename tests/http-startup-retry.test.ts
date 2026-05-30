import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StartupConnectionError } from "../src/errors/startup-connection.error";
import type { HttpFetchFn } from "../src/utils/http.util";
import { HttpUtil } from "../src/utils/http.util";

describe("HttpUtil.getTextWithStartupRetry", () => {
    const url = "http://issuer.example/realms/smart";
    const envKey = "TOKEN_ISSUER";

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("throws StartupConnectionError with env key and url after retries", async () => {
        const fetchFn = vi.fn<HttpFetchFn>().mockRejectedValue(new Error("fetch failed"));
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const http = new HttpUtil(fetchFn);
        const promise = http.getTextWithStartupRetry(url, envKey);
        const assertion = expect(promise).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(StartupConnectionError);
            expect(error).toMatchObject({ envKey, url, attempts: 3 });
            return true;
        });

        await vi.advanceTimersByTimeAsync(3000);
        await vi.advanceTimersByTimeAsync(6000);
        await assertion;

        expect(warnSpy).toHaveBeenCalledTimes(2);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(`Cannot connect to '${envKey}'`);
        expect(warnSpy.mock.calls[0]?.[0]).toContain(url);
        expect(warnSpy.mock.calls[0]?.[0]).toContain("attempt 1/3");
    });
});
