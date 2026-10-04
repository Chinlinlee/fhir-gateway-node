/**
 * Aligns with Java AuthenticationException → HTTP 401 semantics.
 */
export class AuthenticationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AuthenticationError";
    }
}
