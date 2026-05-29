import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolve path under project `resources/` */
export function resourcePath(fileName: string): string {
    return join(packageRoot, "src", "resources", fileName);
}

export function readResourceJson(fileName: string): unknown {
    const raw = readFileSync(resourcePath(fileName), "utf8");
    return JSON.parse(raw) as unknown;
}
