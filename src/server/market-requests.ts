/** Parses /api/markets/[action] bodies into typed requests. Pure, so it unit-tests without HTTP. */
import { DEFAULT_SLIPPAGE_BPS } from "@/lib/api-types";
import type { Side } from "@/lib/markets/math";
import { UserError } from "./errors";
import type { MarketQuoteRequest, MarketRef, MarketTradeRequest } from "./markets";

export type MarketAction = "odds" | "preview" | "trade" | "redeem";
const ACTIONS: readonly MarketAction[] = ["odds", "preview", "trade", "redeem"];

type Body = Record<string, unknown>;

function requiredText(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new UserError(`Missing ${key}`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], message: string): T {
  if (!allowed.includes(value as T)) throw new UserError(message);
  return value as T;
}

export type ParsedMarketRequest =
  | { action: "odds"; req: MarketRef }
  | { action: "preview"; req: MarketQuoteRequest }
  | { action: "trade"; req: MarketTradeRequest }
  | { action: "redeem"; req: MarketRef & { wallet: string } };

export function parseMarketRequest(action: string, body: Body): ParsedMarketRequest {
  const known = oneOf(action, ACTIONS, "Unknown action");
  const ref: MarketRef = { mint: requiredText(body, "mint"), predictionId: requiredText(body, "predictionId") };
  if (known === "odds") return { action: known, req: ref };
  if (known === "redeem") return { action: known, req: { ...ref, wallet: requiredText(body, "wallet") } };
  const quote: MarketQuoteRequest = {
    ...ref,
    side: oneOf<Side>(body.side, ["yes", "no"], "Side must be yes or no"),
    action: oneOf(body.action, ["buy", "sell"] as const, "Action must be buy or sell"),
    amount: requiredText(body, "amount"),
    slippageBps: DEFAULT_SLIPPAGE_BPS,
  };
  if (known === "preview") return { action: known, req: quote };
  return {
    action: known,
    req: { ...quote, wallet: requiredText(body, "wallet"), minReceived: typeof body.minReceived === "string" ? body.minReceived : undefined },
  };
}
