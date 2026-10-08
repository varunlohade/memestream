import type { Metadata } from "next";
import { Suspense } from "react";
import { Overlay, type OverlayLayout } from "@/components/overlay/Overlay";
import { getChain } from "@/server/chain";
import { getCoinDetail } from "@/server/coins";

export const metadata: Metadata = { title: "Overlay", robots: { index: false } };

const LAYOUTS: OverlayLayout[] = ["a", "b", "c"];

/**
 * OBS Browser Source: /overlay/<mint>?layout=a|b|c (default a). Add &preview=1 to see it over a
 * stand-in stream in a normal browser. Recommended source size: 1920×1080.
 */
async function OverlayPage({ params, searchParams }: PageProps<"/overlay/[mint]">) {
  const { mint } = await params;
  const query = await searchParams;
  const layout = LAYOUTS.find((l) => l === String(query.layout ?? "").toLowerCase()) ?? "a";
  // OBS loads this once and runs it for hours: on a missing coin or an RPC hiccup render nothing
  // (never an opaque error box over the stream) and let the 5 s poll fill it in.
  const detail = await getCoinDetail(mint, null).catch(() => null);
  // From the configured public URL, never the request host. The overlay adds /<ticker>.
  const site = new URL(getChain().publicUrl).host;
  return <Overlay mint={mint} initial={detail} layout={layout} site={site} preview={query.preview === "1"} />;
}

export default function Page(props: PageProps<"/overlay/[mint]">) {
  return (
    <Suspense fallback={null}>
      <OverlayPage {...props} />
    </Suspense>
  );
}
