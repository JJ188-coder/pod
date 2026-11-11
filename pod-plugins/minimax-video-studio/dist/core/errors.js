export class UserError extends Error {
    code;
    constructor(message, code = "user_error") {
        super(message);
        this.name = "UserError";
        this.code = code;
    }
}
export class ConflictError extends UserError {
    constructor(message) {
        super(message, "conflict");
        this.name = "ConflictError";
    }
}
