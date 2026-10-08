"use client";
/** The stream's still picture (YouTube or Twitch); falls back to the coin's pixel art if there's none or it fails. */
import Image from "next/image";
import { useState } from "react";
import { parseStreamLink } from "@/lib/stream-link";
import { Scene } from "./Pixel";

export function StreamThumb({ streamUrl, seedKey, sizes }: { streamUrl: string | null; seedKey: string; sizes: string }) {
  const [failed, setFailed] = useState(false);
  const link = streamUrl ? parseStreamLink(streamUrl) : null;
  if (!link?.thumbnailUrl || failed) return <Scene seedKey={seedKey} width={96} height={54} />;
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Image
        src={link.thumbnailUrl}
        alt=""
        fill
        sizes={sizes}
        // Twitch's picture is a live frame: load it fresh instead of through the image cache.
        unoptimized={link.platform === "twitch"}
        style={{ objectFit: "cover" }}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
