import { describe, expect, it } from "vitest";

import { DefaultLaunchContextProvider } from "../src/services/launch-context.service";
import { InMemoryLaunchContextStore } from "../src/services/launch-context-store.service";
import type { LaunchContextStore } from "../src/types/launch-context-store";
import type { VerifiedJwt } from "../src/types/verified-jwt";
import { launchContextFromClaims } from "./helpers/launch-context-fixture";

function verifiedToken(payload: VerifiedJwt["payload"]): VerifiedJwt {
    return { payload, protectedHeader: { alg: "RS256" } };
}

describe("DefaultLaunchContextProvider agent fields", () => {
    it("prefers subject_name over name for the launch agent display name", async () => {
        const launch = await launchContextFromClaims({
            sub: "user-123",
            subject_name: "IHE Name",
            name: "OIDC Name",
        });

        expect(launch.agent.displayName).toBe("IHE Name");
    });

    it("falls back to name when the token carries no subject_name", async () => {
        const launch = await launchContextFromClaims({ sub: "user-123", name: "OIDC Name" });

        expect(launch.agent.displayName).toBe("OIDC Name");
    });

    it("omits the display name when the token carries neither claim", async () => {
        const launch = await launchContextFromClaims({ sub: "user-123" });

        expect(launch.agent.displayName).toBeUndefined();
    });

    it("maps azp, iss and jti onto the launch agent", async () => {
        const provider = new DefaultLaunchContextProvider(new InMemoryLaunchContextStore());

        const launch = await provider.create(
            verifiedToken({
                sub: "user-123",
                azp: "test-client",
                iss: "https://issuer.example/realms/smart",
                jti: "jwt-id-1",
            }),
        );

        expect(launch.agent).toEqual({
            authorizedParty: "test-client",
            issuer: "https://issuer.example/realms/smart",
            tokenId: "jwt-id-1",
            subject: "user-123",
        });
        expect(launch.subject).toBe("user-123");
    });

    it("keeps agent identity claims verbatim", async () => {
        const launch = await launchContextFromClaims({ azp: " test-client " });

        expect(launch.agent.authorizedParty).toBe(" test-client ");
    });
});

describe("DefaultLaunchContextProvider launch context source", () => {
    const storeWithPatient = async (patientId: string): Promise<LaunchContextStore> => {
        const store = new InMemoryLaunchContextStore();
        const created = await store.create({ patientId, ttlSeconds: 300 });
        await store.bind(created.launchId, "user-123", "app-1");
        await store.attachAccessToken("jwt-id-1", created.launchId);
        return store;
    };

    it("takes the patient from the store, keyed by the access token", async () => {
        const provider = new DefaultLaunchContextProvider(await storeWithPatient("456"));

        const launch = await provider.create(verifiedToken({ sub: "user-123", jti: "jwt-id-1" }));

        expect(launch.patientId).toBe("456");
    });

    it("takes the patient list from the store, keyed by the access token", async () => {
        const store = new InMemoryLaunchContextStore();
        const created = await store.create({ patientListId: "list-1", ttlSeconds: 300 });
        await store.bind(created.launchId, "user-123", "app-1");
        await store.attachAccessToken("jwt-id-1", created.launchId);
        const provider = new DefaultLaunchContextProvider(store);

        const launch = await provider.create(verifiedToken({ sub: "user-123", jti: "jwt-id-1" }));

        expect(launch.patientListId).toBe("list-1");
        expect(launch.patientId).toBeUndefined();
    });

    it("ignores patient claims in the token entirely", async () => {
        const provider = new DefaultLaunchContextProvider(await storeWithPatient("456"));

        const launch = await provider.create(
            verifiedToken({ sub: "user-123", jti: "jwt-id-1", patient: "789", patient_list: "list-1" }),
        );

        expect(launch.patientId).toBe("456");
        expect(launch.patientListId).toBeUndefined();
    });

    it("leaves the patient empty when the store holds nothing for the token", async () => {
        const provider = new DefaultLaunchContextProvider(await storeWithPatient("456"));

        const launch = await provider.create(verifiedToken({ sub: "user-123", jti: "another-token" }));

        expect(launch.patientId).toBeUndefined();
    });

    it("leaves the patient empty when the token carries no jti", async () => {
        const provider = new DefaultLaunchContextProvider(await storeWithPatient("456"));

        const launch = await provider.create(verifiedToken({ sub: "user-123" }));

        expect(launch.patientId).toBeUndefined();
    });

    it("leaves the patient empty when the store is unreachable, without throwing", async () => {
        const failing: LaunchContextStore = {
            create: async () => {
                throw new Error("store down");
            },
            isAvailable: async () => false,
            bind: async () => undefined,
            attachAccessToken: async () => undefined,
            getByAccessToken: async () => {
                throw new Error("store down");
            },
        };
        const provider = new DefaultLaunchContextProvider(failing);

        const launch = await provider.create(
            verifiedToken({ sub: "user-123", jti: "jwt-id-1", scope: "patient/Patient.read" }),
        );

        // fail-closed：scope 照舊從 token 讀（它不是 PHI），病人留空讓 checker 拒絕。
        expect(launch.patientId).toBeUndefined();
        expect(launch.scopes.length).toBeGreaterThan(0);
    });
});
