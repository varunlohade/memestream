/** Shared JSON responses for route handlers. */
import { BusyError, UserError } from "@/server/errors";
import { busy } from "@/server/rpc-guard";

export const ok = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

/** The `{ error }` body every route answers with when it refuses a request. */
export const jsonError = (message: string, status: number) => Response.json({ error: message }, { status });

/** User errors become 400 with their message; anything else is a logged 500 with a generic message. */
export function fail(error: unknown) {
  if (error instanceof UserError) return jsonError(error.message, 400);
  console.error(error);
  return jsonError("Something went wrong. Try again.", 500);
}

/** Like fail, but the RPC budget saying no (BusyError) answers busy (503). */
export const failOrBusy = (error: unknown) => (error instanceof BusyError ? busy() : fail(error));

/** Reads a JSON object body; anything else (bad JSON, arrays, text) becomes an empty object. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
