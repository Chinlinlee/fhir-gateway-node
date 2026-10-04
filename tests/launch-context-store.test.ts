import { describe, expect, it } from "vitest";

import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";

/**
 * 窄測試：bind／依鍵回讀／刪除與 TTL 到期，這些行為在 gateway 進入 authorization flow
 * 之前無法經 HTTP 觀察。spec 因此指定 launch context store 介面為唯一的第二個 seam。
 *
 * Narrow tests for the store seam: binding, lookup by key, deletion and TTL expiry are not
 * observable over HTTP until the gateway proxies the authorization flow.
 */
describe("InMemoryLaunchContextStore", () => {
    it("binds a launch context to (subject, client id) and reads it back by that key", async () => {
        const store = new InMemoryLaunchContextStore();
        const created = await store.create({ patientId: "456", encounterId: "enc-1", ttlSeconds: 300 });

        const bound = await store.bind(created.launchId, "user-1", "app-1");

        expect(bound?.patientId).toBe("456");
        expect(bound?.encounterId).toBe("enc-1");
        expect(await store.get("user-1", "app-1")).toEqual(bound);
    });

    it("keeps bindings separate per client id for the same subject", async () => {
        const store = new InMemoryLaunchContextStore();
        const first = await store.create({ patientId: "456", ttlSeconds: 300 });
        const second = await store.create({ patientId: "789", ttlSeconds: 300 });

        await store.bind(first.launchId, "user-1", "app-1");
        await store.bind(second.launchId, "user-1", "app-2");

        expect((await store.get("user-1", "app-1"))?.patientId).toBe("456");
        expect((await store.get("user-1", "app-2"))?.patientId).toBe("789");
    });

    it("treats an unknown launch id as non-existent when binding", async () => {
        const store = new InMemoryLaunchContextStore();

        expect(await store.bind("no-such-launch-id", "user-1", "app-1")).toBeUndefined();
    });

    it("treats an expired launch id as non-existent when binding", async () => {
        let now = 1_000_000;
        const store = new InMemoryLaunchContextStore(() => now);
        const created = await store.create({ patientId: "456", ttlSeconds: 30 });

        now += 30_000;

        expect(await store.bind(created.launchId, "user-1", "app-1")).toBeUndefined();
    });

    it("does not overwrite an existing binding when a launch id is bound again", async () => {
        const store = new InMemoryLaunchContextStore();
        const first = await store.create({ patientId: "456", ttlSeconds: 300 });
        const second = await store.create({ patientId: "789", ttlSeconds: 300 });
        await store.bind(first.launchId, "user-1", "app-1");

        const rebound = await store.bind(second.launchId, "user-1", "app-1");

        expect(rebound).toBeUndefined();
        expect((await store.get("user-1", "app-1"))?.patientId).toBe("456");
    });

    it("consumes the launch id on binding so it cannot be reused by another subject", async () => {
        const store = new InMemoryLaunchContextStore();
        const created = await store.create({ patientId: "456", ttlSeconds: 300 });
        await store.bind(created.launchId, "user-1", "app-1");

        expect(await store.bind(created.launchId, "user-2", "app-1")).toBeUndefined();
        expect(await store.get("user-2", "app-1")).toBeUndefined();
    });

    it("deletes a binding and reports whether one existed", async () => {
        const store = new InMemoryLaunchContextStore();
        const created = await store.create({ patientId: "456", ttlSeconds: 300 });
        await store.bind(created.launchId, "user-1", "app-1");

        expect(await store.delete("user-1", "app-1")).toBe(true);
        expect(await store.get("user-1", "app-1")).toBeUndefined();
        expect(await store.delete("user-1", "app-1")).toBe(false);
    });

    it("returns undefined for a subject that was never bound", async () => {
        const store = new InMemoryLaunchContextStore();

        expect(await store.get("nobody", "no-app")).toBeUndefined();
    });
});
