import { getLaunchFeeSol } from "@/server/coins";
import { busy, withRpcGuard } from "@/server/rpc-guard";

/** GET /api/launch-fee -> { sol: "0" | "0.05" }: our config's launch fee, read once (it never changes). */
export const GET = withRpcGuard({ name: "launch-fee", burst: 10, perSecond: 1 }, async () => {
  const sol = await getLaunchFeeSol().catch(() => null);
  return sol === null ? busy() : Response.json({ sol });
});
