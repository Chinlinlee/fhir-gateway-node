# Gateway 不簽發 access token

評估「讓 gateway 變成 SMART launch broker」時，評估了 gateway 自行簽發 access token 的方案（gateway 同時是 authorization server 與 resource server）。**決定不採用；token 一律由外部 IdP 簽發，gateway 只驗證。**

## 為什麼

**沒有先例。** 查證 industry precedent 時，找到的案例中沒有任何一個是「app-tier gateway 完全不委派 IdP、自己簽 FHIR access token」。最接近的兩個案例都不這樣做：

- **OpenEMR / Aidbox / Medplum / Health Gorilla** — 都是產品一體自架（EHR 或平台本身同時是 AS 與 RS），不是「某個 proxy 簽 token 給別人的 FHIR server」
- **Proxy Smart** — 正是我們的處境（gateway 持有 launch context、做 scope narrowing、決定 access control），**而它明確讓 Keycloak 簽 token**，launch context 存在 Keycloak user attribute 再由 mapper 注入

**規格中立不等於規格背書。** SMART App Launch 2.2 說「*This specification is agnostic about how the EHR resource server and the EHR authorization server are integrated*」，token 格式也「*left up to the organization that issues the access token*」，台灣《醫療法》、《資通系統防護基準》、HIPAA 45 CFR §164.312 皆查不到「簽發者必須是獨立 IdP／CA」的明文。**合規上可行——但「沒有條文禁止」不等於「有先例承擔」。**

**上游 FHIR server 必須驗你的簽章。** gateway 自簽 token 意味著每一家醫院、每一個 EHR 都要被說服「請信任這個 proxy 的 JWKS」。那正是 gateway 價值（可替換 IdP）的反面：**每換一家醫院就要重新談一次信任**。而 SMART 規格的心智模型是 1 AS : 1 EHR，硬性條文寫的是「*the **EHR** SHALL establish a patient in context*」——義務在 EHR，不在 proxy。

## Consequences

- **Trust boundary 不變。** 簽發權留在獨立於 app-tier 的 IdP（有 TLS、有 session 管理、有 rotation 機制），gateway 永遠只是驗票員。這直接消除了一個架構級疑慮：gateway 被入侵的最壞情況從「可偽造任何身分」降回「可越權讀取既有合法 token 能讀的範圍」。
- **launch context 必須由 IdP 側協助才能進 token**，或完全不放進 token——這推導出 ADR-0002。
- gateway 仍然需要參與 authorization flow（否則 context 綁不到使用者，見 ADR-0002）。
- 「IdP 可插拔」的價值下降為「gateway 不依賴 IdP 的 Keycloak 專屬擴充」。這個目標由 spec #1（IdP-agnostic identity layer）達成，**不需要 gateway 成為 AS**。