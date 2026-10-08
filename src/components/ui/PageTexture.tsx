"use client";
/** Applies the deepslate texture to the page background once the canvas is available. */
import { useEffect } from "react";
import { textureUrl } from "@/components/pixel/art";

export function PageTexture() {
  useEffect(() => {
    document.body.style.backgroundImage = `url(${textureUrl("deep", 4)})`;
  }, []);
  return null;
}
