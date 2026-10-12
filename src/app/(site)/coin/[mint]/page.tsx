import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CoinPageView } from "@/components/coin/CoinPageView";
import { getCoinDetail } from "@/server/coins";
import { networkInfo } from "@/server/chain";
import { marketsEnabled, predictionsEnabled } from "@/server/predictions/flag";

export async function generateMetadata({ params }: PageProps<"/coin/[mint]">): Promise<Metadata> {
  // Shares getCoinDetail's cache and RPC budget; on "busy" or any error, a generic title.
  const coin = (await getCoinDetail((await params).mint, null).catch(() => null))?.coin;
  if (!coin) return { title: "Coin not found" };
  return {
    title: `$${coin.symbol}`,
    description: `${coin.name}: buy the stream you think will pop. 80% of fees go to the streamer.`,
  };
}

async function Coin({ params }: { params: PageProps<"/coin/[mint]">["params"] }) {
  const { mint } = await params;
  // Unknown coin, or the RPC budget said no: the not-found state (never an unbudgeted read).
  const detail = await getCoinDetail(mint, null).catch(() => null);
  if (!detail) notFound();
  const network = networkInfo();
  // Markets' copy names the network's SOL, and says when it's test money.
  const sol = network.walletChain === "solana:mainnet" ? { label: network.label, test: false } : { label: network.label, test: true };
  return <CoinPageView mint={mint} initial={detail} predictions={predictionsEnabled()} network={sol} markets={marketsEnabled()} />;
}

export default function Page(props: PageProps<"/coin/[mint]">) {
  return (
    <Suspense fallback={<p className="notice" style={{ margin: 32 }}>Loading coin</p>}>
      <Coin params={props.params} />
    </Suspense>
  );
}
