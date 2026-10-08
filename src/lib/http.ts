/** JSON fetch helpers for the browser. No runtime dependencies. */

/** An HTTP error with its status, so callers can tell a bad request (4xx) from a passing fault. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Fetches JSON; throws HttpError with the server's user-facing `error`, or a plain message. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const json = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new HttpError(json?.error ?? `Request failed (${response.status})`, response.status);
  if (json === null) throw new Error("Unexpected response from server");
  return json as T;
}

export const postJson = <T>(url: string, body: unknown, signal?: AbortSignal) =>
  fetchJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
