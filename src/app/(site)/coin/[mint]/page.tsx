import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CoinPageView } from "@/components/coin/CoinPageView";
import { getCoinDetail } from "@/server/coins";
import { predictionsEnabled } from "@/server/predictions/flag";

export async function generateMetadata({ params }: PageProps<"/coin/[mint]">): Promise<Metadata> {
  // Shares getCoinDetail's cache and RPC budget; on "busy" or any error, the site's default title.
  const detail = await getCoinDetail((await params).mint, null).catch(() => undefined);
  if (detail === null) return { title: "Coin not found" };
  if (!detail) return {};
  const { coin } = detail;
  return {
    title: `$${coin.symbol}`,
    description: `${coin.name}: bet on what happens next on stream, or buy its coin. 64% of each trade fee goes to the streamer.`,
  };
}

async function Coin({ params }: { params: PageProps<"/coin/[mint]">["params"] }) {
  const { mint } = await params;
  // Not one of our coins: not found. The RPC budget said no or a read failed (a known coin is served
  // from its last good data when there is any): a quiet retry, never "not found".
  const detail = await getCoinDetail(mint, null).catch(() => undefined);
  if (detail === null) notFound();
  if (!detail) return <CoinRetry />;
  return <CoinPageView mint={mint} initial={detail} predictions={predictionsEnabled()} />;
}

const RETRY_SECONDS = 5;

function CoinRetry() {
  return (
    <>
      <meta httpEquiv="refresh" content={String(RETRY_SECONDS)} />
      <p className="notice" style={{ margin: 32 }}>Loading coin</p>
    </>
  );
}

export default function Page(props: PageProps<"/coin/[mint]">) {
  return (
    <Suspense fallback={<p className="notice" style={{ margin: 32 }}>Loading coin</p>}>
      <Coin params={props.params} />
    </Suspense>
  );
}
