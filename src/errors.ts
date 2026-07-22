export type KbErrorCode =
  | "DB_NOT_INITIALIZED"
  | "DOMAIN_MISMATCH"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_COMMAND"
  | "SCHEMA_MISMATCH"
  | "MIGRATION_REQUIRED"
  | "CONFLICT"
  | "INTERNAL_FAILURE";

export class KbError extends Error {
  readonly code: KbErrorCode;

  constructor(code: KbErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KbError";
    this.code = code;
  }
}

export function asKbError(error: unknown): KbError {
  if (error instanceof KbError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not initialized/i.test(message)) return new KbError("DB_NOT_INITIALIZED", message, { cause: error });
  if (/not found/i.test(message)) return new KbError("NOT_FOUND", message, { cause: error });
  if (/already exists|already promoted|conflict|UNIQUE constraint/i.test(message)) {
    return new KbError("CONFLICT", message, { cause: error });
  }
  if (/schema v1|migration/i.test(message)) return new KbError("MIGRATION_REQUIRED", message, { cause: error });
  if (/schema|metadata/i.test(message)) return new KbError("SCHEMA_MISMATCH", message, { cause: error });
  if (/invalid|required|does not|cannot|must|unknown|only applies|refusing|secret/i.test(message)) {
    return new KbError("INVALID_INPUT", message, { cause: error });
  }
  return new KbError("INTERNAL_FAILURE", message, { cause: error });
}
