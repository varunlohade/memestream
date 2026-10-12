/** Turns a request body into a game action, refusing anything malformed before it reaches the engine. */
import { isBase58Of } from "@/lib/base58";
import type { Action } from "@/lib/predictions/engine";
import { isOutcome, isSide } from "@/lib/predictions/rules";

const isId = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{0,3}$/.test(value);

export function parseAction(body: Record<string, unknown>): Action | null {
  switch (body.kind) {
    case "suggest":
      return typeof body.text === "string" ? { kind: "suggest", text: body.text } : null;
    case "upvote":
    case "remove":
    case "approve":
    case "flag":
      return isId(body.id) ? { kind: body.kind, id: body.id } : null;
    case "bet":
      return isSide(body.side) && typeof body.amount === "number" ? { kind: "bet", side: body.side, amount: body.amount } : null;
    case "launch": {
      const windowMin = typeof body.windowMin === "number" ? body.windowMin : undefined;
      if (isId(body.id)) return { kind: "launch", id: body.id, windowMin };
      return typeof body.text === "string" ? { kind: "launch", text: body.text, windowMin } : null;
    }
    case "resolve":
      return isOutcome(body.outcome) ? { kind: "resolve", outcome: body.outcome } : null;
    case "mod":
      return typeof body.wallet === "string" && isBase58Of(body.wallet, 32) && typeof body.add === "boolean"
        ? { kind: "mod", wallet: body.wallet, add: body.add }
        : null;
    case "crowd":
      return typeof body.on === "boolean" ? { kind: "crowd", on: body.on } : null;
    default:
      return null;
  }
}
