import { connection } from "next/server";
import { Suspense } from "react";
import { GoLiveView } from "@/components/golive/GoLiveView";
import { getLaunchFeeSol } from "@/server/coins";

async function GoLiveWithFee() {
  await connection(); // read at request time, not while prerendering at build
  // From the on-chain config: free on devnet, 0.05 SOL on mainnet. Unknown (busy) shows no line.
  const fee = await getLaunchFeeSol().catch(() => null);
  return <GoLiveView launchFeeSol={fee && Number(fee) > 0 ? fee : null} />;
}

export default function GoLive() {
  return (
    <Suspense fallback={<GoLiveView launchFeeSol={null} />}>
      <GoLiveWithFee />
    </Suspense>
  );
}
