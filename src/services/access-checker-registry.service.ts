import { AuthenticationError } from "../errors/authentication.error";
import type { AccessChecker, AccessCheckerCreateContext, AccessCheckerFactory } from "../types/access-checker";
import { basicAccessCheckerFactory } from "./access-checkers/basic-access-checker.service";
import { listAccessCheckerFactory } from "./access-checkers/list-access-checker.service";
import { patientAccessCheckerFactory } from "./access-checkers/patient-access-checker.service";
import { permissiveAccessCheckerFactory } from "./access-checkers/permissive-access-checker.service";

/**
 * 依 ACCESS_CHECKER 名稱解析 Factory；對齊 Java @Named plugin registry。
 * Resolves AccessCheckerFactory by ACCESS_CHECKER name.
 */
export class AccessCheckerRegistryService {
    private readonly factories = new Map<string, AccessCheckerFactory>();

    register(name: string, factory: AccessCheckerFactory): void {
        this.factories.set(name, factory);
    }

    has(name: string): boolean {
        return this.factories.has(name);
    }

    getRegisteredNames(): string[] {
        return [...this.factories.keys()];
    }

    create(name: string, context: AccessCheckerCreateContext): AccessChecker {
        const factory = this.factories.get(name);
        if (!factory) {
            throw new AuthenticationError(`No AccessChecker factory registered for '${name}'`);
        }
        return factory.create(context);
    }
}

/** 註冊內建 AccessChecker 插件。 */
export function createDefaultAccessCheckerRegistry(): AccessCheckerRegistryService {
    const registry = new AccessCheckerRegistryService();
    registry.register("permissive", permissiveAccessCheckerFactory);
    registry.register("list", listAccessCheckerFactory);
    registry.register("patient", patientAccessCheckerFactory);
    registry.register("basic", basicAccessCheckerFactory);
    return registry;
}
