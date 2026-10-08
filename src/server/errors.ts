/** Errors the API may show to users. Everything else becomes a generic 500. */
import { InputError } from "@/lib/dbc/errors";

export class UserError extends Error {
  override name = "UserError";
}

/** The server-wide RPC budget said no: answer "busy" (503), or render the empty state on a page. */
export class BusyError extends Error {
  override name = "BusyError";
  constructor() {
    super("Busy, try again");
  }
}

/** Library input/state errors become user errors; anything else passes through unchanged. */
export function asUserFacing(error: unknown): unknown {
  return error instanceof InputError ? new UserError(error.message) : error;
}
