/**
 * One RPC call budget for the whole site, shared by every server instance and every route that
 * reads the chain, so the RPC bill has a hard cap. Set it from the RPC plan's limits on mainnet.
 */
import { sharedLimiter } from "./shared-limit";

const RPC_BURST = 300;
const RPC_PER_SECOND = 60;
const budget = sharedLimiter("rpc-budget", RPC_BURST, RPC_PER_SECOND);

export const takeRpcBudget = (calls: number): Promise<boolean> => budget.take("all", calls);
