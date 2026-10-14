import { isMainnet } from "@/lib/network";

/** Predictions (free points, no money) are hidden everywhere unless MEMESTREAM_PREDICTIONS=1. */
export const predictionsEnabled = () => process.env.MEMESTREAM_PREDICTIONS === "1";
/**
 * On-chain prediction markets (real SOL) on top of predictions, only with MEMESTREAM_MARKETS=1 too.
 * Off: no markets are made and the predictions game is exactly the free-points one.
 * Always off on mainnet (the owner, 2026-10-15), whatever the env says: see MAINNET-CHECKLIST.md.
 */
export const marketsEnabled = () => predictionsEnabled() && process.env.MEMESTREAM_MARKETS === "1" && !isMainnet();
