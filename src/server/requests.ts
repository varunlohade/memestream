/** Parses API request bodies into typed requests. Pure, so it unit-tests without HTTP. */
import { DEFAULT_SLIPPAGE_BPS, type TxAction } from "@/lib/api-types";
import { UserError } from "./errors";
import type { LaunchRequest, QuoteRequest, TradeRequest } from "./transactions";

type Body = Record<string, unknown>;

function text(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value.trim()) throw new UserError(`Missing ${key}`);
  return value;
}

function side(value: unknown): "buy" | "sell" {
  if (value !== "buy" && value !== "sell") throw new UserError("Side must be buy or sell");
  return value;
}

export function parseQuote(params: URLSearchParams): QuoteRequest {
  return {
    mint: text(Object.fromEntries(params), "mint"),
    side: side(params.get("side")),
    amount: text(Object.fromEntries(params), "amount"),
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
  const wallet = text(body, "wallet");
  const typed = action as TxAction;
  switch (typed) {
    case "launch":
      return {
        action: "launch",
        req: {
          wallet,
          name: text(body, "name"),
          symbol: text(body, "symbol"),
          streamUrl: typeof body.streamUrl === "string" ? body.streamUrl : undefined,
        },
      };
    case "trade":
      return {
        action: "trade",
        req: { wallet, mint: text(body, "mint"), side: side(body.side), amount: text(body, "amount"), slippageBps: DEFAULT_SLIPPAGE_BPS },
      };
    case "claim":
    case "graduate":
      return { action: typed, req: { wallet, mint: text(body, "mint") } };
  }
}
