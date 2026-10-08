/** Shared JSON responses for route handlers. */
import { UserError } from "@/server/errors";

export const ok = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });

/** User errors become 400 with their message; anything else is a logged 500 with a generic message. */
export function fail(error: unknown) {
  if (error instanceof UserError) return Response.json({ error: error.message }, { status: 400 });
  console.error(error);
  return Response.json({ error: "Something went wrong. Try again." }, { status: 500 });
}

/** Reads a JSON object body; anything else (bad JSON, arrays, text) becomes an empty object. */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
