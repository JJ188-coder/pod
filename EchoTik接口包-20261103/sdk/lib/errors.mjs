export class EchoTikSdkError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = "EchoTikSdkError";
    this.code = code;
  }
}

export function sdkError(code, message, cause) {
  return new EchoTikSdkError(code, message, cause ? { cause } : undefined);
}
