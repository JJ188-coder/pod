export class UserError extends Error {
  readonly code: string;

  constructor(message: string, code = "user_error") {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export class ConflictError extends UserError {
  constructor(message: string) {
    super(message, "conflict");
    this.name = "ConflictError";
  }
}
