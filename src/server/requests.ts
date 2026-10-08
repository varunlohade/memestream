/** Parses API request bodies into typed requests. Pure, so it unit-tests without HTTP. */
import { DEFAULT_SLIPPAGE_BPS, type TxAction } from "@/lib/api-types";
import { UserError } from "./errors";
import type { LaunchRequest, QuoteRequest, TradeRequest } from "./transactions";

type Body = Record<string, unknown>;

function requiredText(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new UserError(`Missing ${key}`);
  return value;
}

function parseSide(value: unknown): "buy" | "sell" {
  if (value !== "buy" && value !== "sell") throw new UserError("Side must be buy or sell");
  return value;
}

export function parseQuote(params: URLSearchParams): QuoteRequest {
  const query: Body = Object.fromEntries(params);
  return {
    mint: requiredText(query, "mint"),
    side: parseSide(params.get("side")),
    amount: requiredText(query, "amount"),
    slippageBps: DEFAULT_SLIPPAGE_BPS,
  };
}

export type ParsedTx =
  | { action: "launch"; req: LaunchRequest }
  | { action: "trade"; req: TradeRequest }
  | { action: "claim" | "graduate"; req: { wallet: string; mint: string } };

const ACTIONS: readonly TxAction[] = ["launch", "trade", "claim", "graduate"];

export function parseTxRequest(action: string, body: Body): ParsedTx {
  if (!(ACTIONS as readonly string[]).includes(action)) throw new UserError("Unknown action");
  const wallet = requiredText(body, "wallet");
  const knownAction = action as TxAction;
  switch (knownAction) {
    case "launch":
      return {
        action: "launch",
        req: {
          wallet,
          name: requiredText(body, "name"),
          symbol: requiredText(body, "symbol"),
          streamUrl: typeof body.streamUrl === "string" ? body.streamUrl : undefined,
        },
      };
    case "trade":
      return {
        action: "trade",
        req: {
          wallet,
          mint: requiredText(body, "mint"),
          side: parseSide(body.side),
          amount: requiredText(body, "amount"),
          slippageBps: DEFAULT_SLIPPAGE_BPS,
          minReceived: typeof body.minReceived === "string" ? body.minReceived : undefined,
        },
      };
    case "claim":
    case "graduate":
      return { action: knownAction, req: { wallet, mint: requiredText(body, "mint") } };
  }
}
