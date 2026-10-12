/** Parses API request bodies into typed requests. Pure, so it unit-tests without HTTP. */
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_CHOICES_BPS, type TxAction } from "@/lib/api-types";
import { UserError } from "./errors";
import type { MarketRef, MarketTradeRequest } from "./markets";
import { parseMarketRequest } from "./market-requests";
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

/** A whitelisted max slippage (number, or digits from a query string); anything else gets the default. */
export function parseSlippage(value: unknown): number {
  const bps = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return (SLIPPAGE_CHOICES_BPS as readonly unknown[]).includes(bps) ? (bps as number) : DEFAULT_SLIPPAGE_BPS;
}

export function parseQuote(params: URLSearchParams): QuoteRequest {
  const query: Body = Object.fromEntries(params);
  return {
    mint: requiredText(query, "mint"),
    side: parseSide(params.get("side")),
    amount: requiredText(query, "amount"),
    slippageBps: parseSlippage(params.get("slippageBps")),
  };
}

export type ParsedTx =
  | { action: "launch"; req: LaunchRequest }
  | { action: "trade"; req: TradeRequest }
  | { action: "claim" | "graduate" | "claim-lp"; req: { wallet: string; mint: string } }
  | { action: "market"; req: MarketTradeRequest }
  | { action: "market-redeem"; req: MarketRef & { wallet: string } };

const ACTIONS: readonly TxAction[] = ["launch", "trade", "claim", "graduate", "claim-lp", "market", "market-redeem"];

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
          slippageBps: parseSlippage(body.slippageBps),
          minReceived: typeof body.minReceived === "string" ? body.minReceived : undefined,
        },
      };
    case "claim":
    case "graduate":
    case "claim-lp":
      return { action: knownAction, req: { wallet, mint: requiredText(body, "mint") } };
    // The app's money flow (useTx().run) posts here; the bodies are the /api/markets ones.
    case "market": {
      const parsed = parseMarketRequest("trade", body);
      if (parsed.action !== "trade") throw new UserError("Unknown action");
      return { action: "market", req: parsed.req };
    }
    case "market-redeem": {
      const parsed = parseMarketRequest("redeem", body);
      if (parsed.action !== "redeem") throw new UserError("Unknown action");
      return { action: "market-redeem", req: parsed.req };
    }
  }
}
