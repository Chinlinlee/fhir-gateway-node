import { fetch } from "undici";

export class HttpUtil {
    async getText(url: string): Promise<string> {
        const response = await fetch(url, {
            headers: {
                "Accept-Charset": "utf-8",
            },
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Error accessing resource ${url}; status ${response.status}`);
        }

        return response.text();
    }

    /** OIDC discovery document at TOKEN_ISSUER + WELL_KNOWN_ENDPOINT */
    async fetchWellKnownConfig(tokenIssuer: string, wellKnownEndpoint: string): Promise<string> {
        const url = joinIssuerPath(tokenIssuer, wellKnownEndpoint);
        return this.getText(url);
    }
}

export function joinIssuerPath(issuer: string, segment: string): string {
    const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const path = segment.startsWith("/") ? segment.slice(1) : segment;
    return `${base}/${path}`;
}
