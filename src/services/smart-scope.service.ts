import { isValidFhirResourceType } from "../utils/fhir.util";

/** SMART scope principal；PatientAccessChecker 僅用 PATIENT。 */
export const SmartScopePrincipal = {
    USER: "user",
    PATIENT: "patient",
    SYSTEM: "system",
} as const;

export type SmartScopePrincipal = (typeof SmartScopePrincipal)[keyof typeof SmartScopePrincipal];

/**
 * SMART permission；順序對齊 Java SmartFhirScope.Permission（v2 cruds 解析依賴此順序）。
 * https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html
 */
export const SmartScopePermission = {
    CREATE: "CREATE",
    READ: "READ",
    UPDATE: "UPDATE",
    DELETE: "DELETE",
    SEARCH: "SEARCH",
} as const;

export type SmartScopePermission = (typeof SmartScopePermission)[keyof typeof SmartScopePermission];

const PERMISSION_ORDER: SmartScopePermission[] = [
    SmartScopePermission.CREATE,
    SmartScopePermission.READ,
    SmartScopePermission.UPDATE,
    SmartScopePermission.DELETE,
    SmartScopePermission.SEARCH,
];

const PERMISSION_CHAR: Record<SmartScopePermission, string> = {
    [SmartScopePermission.CREATE]: "c",
    [SmartScopePermission.READ]: "r",
    [SmartScopePermission.UPDATE]: "u",
    [SmartScopePermission.DELETE]: "d",
    [SmartScopePermission.SEARCH]: "s",
};

export const ALL_RESOURCE_TYPES_WILDCARD = "*";

const ALL_RESOURCE_PERMISSIONS_WILDCARD = "*";
const SMART_V1_READ = "read";
const SMART_V1_WRITE = "write";

/** 對齊 Java SmartFhirScope.VALID_SCOPE_PATTERN */
const VALID_SCOPE_PATTERN = /^((?:user|patient|system)\/((?:\*)|(?:[a-zA-Z]+))\.((?:\*)|(?:[cruds]+)|(?:read|write)))$/;

export type SmartFhirScope = {
    principal: SmartScopePrincipal;
    resourceType: string;
    permissions: ReadonlySet<SmartScopePermission>;
};

function parsePrincipal(value: string): SmartScopePrincipal {
    switch (value.toLowerCase()) {
        case SmartScopePrincipal.USER:
            return SmartScopePrincipal.USER;
        case SmartScopePrincipal.PATIENT:
            return SmartScopePrincipal.PATIENT;
        case SmartScopePrincipal.SYSTEM:
            return SmartScopePrincipal.SYSTEM;
        default:
            throw new Error(`Invalid SMART scope principal: ${value}`);
    }
}

function extractPermissions(permissionString: string): Set<SmartScopePermission> {
    const permissions = new Set<SmartScopePermission>();

    if (permissionString === ALL_RESOURCE_PERMISSIONS_WILDCARD) {
        for (const permission of PERMISSION_ORDER) {
            permissions.add(permission);
        }
        return permissions;
    }

    if (permissionString === SMART_V1_READ) {
        permissions.add(SmartScopePermission.READ);
        permissions.add(SmartScopePermission.SEARCH);
        return permissions;
    }

    if (permissionString === SMART_V1_WRITE) {
        permissions.add(SmartScopePermission.CREATE);
        permissions.add(SmartScopePermission.UPDATE);
        permissions.add(SmartScopePermission.DELETE);
        return permissions;
    }

    const permissionTokens = permissionString.split("");
    let permissionTokensCounter = 0;

    for (const permission of PERMISSION_ORDER) {
        if (permissionTokens[permissionTokensCounter] === PERMISSION_CHAR[permission]) {
            permissionTokensCounter++;
            permissions.add(permission);
        }
        if (permissionTokensCounter === permissionTokens.length) {
            break;
        }
    }

    if (permissionTokensCounter !== permissionTokens.length) {
        throw new Error(`Invalid permission string ${permissionString}`);
    }

    return permissions;
}

function createSmartScope(scope: string): SmartFhirScope {
    const split = scope.split("/");
    if (split.length !== 2 || !split[0] || !split[1]) {
        throw new Error(`Invalid SMART scope format: ${scope}`);
    }

    const principal = parsePrincipal(split[0]);
    const permissionSplit = split[1].split(".");
    if (permissionSplit.length !== 2 || !permissionSplit[0] || !permissionSplit[1]) {
        throw new Error(`Invalid SMART scope format: ${scope}`);
    }

    const resourceType = permissionSplit[0];
    if (resourceType !== ALL_RESOURCE_TYPES_WILDCARD && !isValidFhirResourceType(resourceType)) {
        throw new Error(`Invalid resource type ${resourceType}`);
    }

    const permissions = extractPermissions(permissionSplit[1]);
    return { principal, resourceType, permissions };
}

/** 從 JWT scope claim（空白分隔 token 列表）解析 SMART FHIR scopes。 */
export function extractSmartFhirScopesFromTokens(tokens: readonly string[]): SmartFhirScope[] {
    const scopes: SmartFhirScope[] = [];

    for (const token of tokens) {
        if (VALID_SCOPE_PATTERN.test(token)) {
            scopes.push(createSmartScope(token));
        }
    }

    return scopes;
}

/** 僅評估指定 principal 的 scopes；PatientAccessChecker 傳 PATIENT。 */
export class SmartScopeChecker {
    private readonly permissionsByResourceType: Map<string, Set<SmartScopePermission>>;

    constructor(scopes: readonly SmartFhirScope[], permissionContext: SmartScopePrincipal) {
        this.permissionsByResourceType = new Map();

        for (const scope of scopes) {
            if (scope.principal !== permissionContext) {
                continue;
            }

            const existing = this.permissionsByResourceType.get(scope.resourceType) ?? new Set<SmartScopePermission>();
            for (const permission of scope.permissions) {
                existing.add(permission);
            }
            this.permissionsByResourceType.set(scope.resourceType, existing);
        }
    }

    hasPermission(resourceType: string, permission: SmartScopePermission): boolean {
        const resourcePermissions = this.permissionsByResourceType.get(resourceType) ?? new Set<SmartScopePermission>();
        const wildcardPermissions =
            this.permissionsByResourceType.get(ALL_RESOURCE_TYPES_WILDCARD) ?? new Set<SmartScopePermission>();

        return resourcePermissions.has(permission) || wildcardPermissions.has(permission);
    }
}
