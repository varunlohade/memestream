/** Shared pieces for the predictions routes (free points, no money). */
import { GameError } from "@/lib/predictions/engine";
import { busy } from "@/server/rpc-guard";
import { bearer } from "@/server/predictions/identity";
import { predictions, predictionsEnabled } from "@/server/predictions";
import { ContentionError, type PredictionsService, UnknownCoinError } from "@/server/predictions/service";
import { failOrBusy, jsonError } from "../respond";

/** The service, or the response to send instead: 404 while the feature flag is off, 503 if not set up. */
export function gate(): PredictionsService | Response {
  if (!predictionsEnabled()) return jsonError("Not found", 404);
  const ready = predictions();
  return "error" in ready ? jsonError(ready.error, 503) : ready.service;
}

/** The wallet from the request's session token (never from a wallet address the client claims). */
export const signedInWallet = (service: PredictionsService, request: Request) => service.walletOf(bearer(request));

export function predictionsError(error: unknown): Response {
  if (error instanceof GameError) return jsonError(error.message, 400);
  if (error instanceof UnknownCoinError) return jsonError("Coin not found", 404);
  if (error instanceof ContentionError) return busy();
  return failOrBusy(error);
}
