/**
 * Every API route that reaches the chain goes through withRpcGuard (a test enforces it):
 * a per-client rate limit, plus the server-wide RPC call budget for the calls it actually makes.
 */
import { clientIp } from "./rate-limit";
import { takeRpcBudget } from "./rpc-budget";
import { sharedLimiter } from "./shared-limit";

export type RpcGuard = {
  /** Draws `calls` from the server-wide budget; false means "too busy", answer with busy(). */
  spend: (calls: number) => Promise<boolean>;
};

export const busy = () => Response.json({ error: "Busy, try again" }, { status: 503 });
const tooMany = () => Response.json({ error: "Too many requests" }, { status: 429 });

type Options = {
  /** The route's name: its key in the shared store, the same on every server instance. */
  name: string;
  /** Requests a client may burst, and refill per second. */
  burst: number;
  perSecond: number;
  /** RPC calls to draw before the handler runs (for routes without their own cache). 0 = handler spends. */
  calls?: number;
};

export function withRpcGuard<C>(
  options: Options,
  handler: (request: Request, context: C, guard: RpcGuard) => Promise<Response>,
): (request: Request, context: C) => Promise<Response> {
  const perClient = sharedLimiter(`client:${options.name}`, options.burst, options.perSecond);
  const guard: RpcGuard = { spend: takeRpcBudget };
  return async (request, context) => {
    if (!(await perClient.take(clientIp(request)))) return tooMany();
    if (options.calls && !(await guard.spend(options.calls))) return busy();
    return handler(request, context, guard);
  };
}
