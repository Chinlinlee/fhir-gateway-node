import { defineConfig } from "tsdown";

export default defineConfig({
    entry: ["src/index.ts"],
    platform: "node",
    target: "node24",
    format: ["cjs"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
    dts: false,
    deps: {
        alwaysBundle: [/.*/],
    },
});
