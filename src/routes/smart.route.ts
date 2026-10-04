import { Elysia } from "elysia";
import { SMART_API_PREFIX, SMART_AUTHORIZE_PATH, SMART_CALLBACK_PATH, SMART_TOKEN_PATH } from "../constants/routes";
import type { SmartAuthorizationDeps } from "../controllers/smart/smart-authorization.controller";
import { oauthErrorResponse, SmartAuthorizationController } from "../controllers/smart/smart-authorization.controller";
import { OAuthError } from "../errors/oauth.error";

/**
 * gateway 代理的 SMART authorization flow：對外的 authorization endpoint、自己的 callback，
 * 與 token endpoint。
 *
 * 只在 `GATEWAY_PUBLIC_BASE_URL` 有設定時才註冊——未設定時 gateway 維持被動，SMART App
 * 照舊直接對 IdP 走授權流程。
 */
export const smartRoute = (deps: SmartAuthorizationDeps) =>
    new Elysia({ name: "smart-authorization", prefix: SMART_API_PREFIX })
        .get(SMART_AUTHORIZE_PATH, ({ request }) =>
            respond(() => SmartAuthorizationController.authorize(request, deps)),
        )
        .get(SMART_CALLBACK_PATH, ({ request }) => respond(() => SmartAuthorizationController.callback(request, deps)))
        .post(SMART_TOKEN_PATH, ({ request }) => respond(() => SmartAuthorizationController.token(request, deps)));

/**
 * App 沒有全域 `onError`，所以在這裡把流程錯誤轉成 OAuth 的錯誤形狀。
 * 非 OAuth 的錯誤一律是 gateway 自身的故障：500 加 `server_error`，細節只進日誌。
 */
async function respond(work: () => Promise<Response>): Promise<Response> {
    try {
        return await work();
    } catch (error) {
        if (error instanceof OAuthError) {
            return oauthErrorResponse(error);
        }
        return oauthErrorResponse(
            new OAuthError("server_error", "The authorization request could not be completed.", { cause: error }),
        );
    }
}
