import { cors } from "@elysiajs/cors";
import { Elysia } from "elysia";

/**
 * CORS for SMART apps; Bearer token auth — no cookie session (SPEC §12).
 * 允許瀏覽器 SMART App 帶 Authorization 呼叫 Gateway。
 */
export const corsPlugin = new Elysia({ name: "cors" }).use(
    cors({
        origin: true,
        allowedHeaders: ["Authorization", "Content-Type", "Accept", "Prefer"],
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
);
