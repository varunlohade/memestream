"use client";
/** The stream's YouTube thumbnail; falls back to the coin's pixel art if there's none or it fails. */
import Image from "next/image";
import { useState } from "react";
import { parseStreamLink } from "@/lib/stream-link";
import { Scene } from "./Pixel";

export function StreamThumb({ streamUrl, seedKey, alt }: { streamUrl: string | null; seedKey: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const thumbnail = streamUrl ? parseStreamLink(streamUrl)?.thumbnailUrl : null;
  if (!thumbnail || failed) return <Scene seedKey={seedKey} width={96} height={54} />;
  return (
    <Image
      src={thumbnail}
      alt={alt}
      fill
      sizes="(max-width: 640px) 100vw, 33vw"
      style={{ objectFit: "cover" }}
      onError={() => setFailed(true)}
    />
  );
}
