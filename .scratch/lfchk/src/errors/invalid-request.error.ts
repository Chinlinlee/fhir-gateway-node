/**
 * Aligns with Java InvalidRequestException.
 */
export class InvalidRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidRequestError";
    }
}
