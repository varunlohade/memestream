import { connection } from "next/server";
import { Suspense } from "react";
import { GoLiveView } from "@/components/golive/GoLiveView";
import { getLaunchFeeSol } from "@/server/coins";

async function GoLiveWithFee() {
  await connection(); // read at request time, not while prerendering at build
  // From the on-chain config: "0" on devnet, "0.05" on mainnet. Null (busy) = unknown: the form
  // says "checking…", keeps Launch disabled and retries.
  const fee = await getLaunchFeeSol().catch(() => null);
  return <GoLiveView launchFeeSol={fee} />;
}

export default function GoLive() {
  return (
    <Suspense fallback={<GoLiveView launchFeeSol={null} />}>
      <GoLiveWithFee />
    </Suspense>
  );
}
