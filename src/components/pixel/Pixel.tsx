"use client";
/** Small React wrappers around the canvas pixel art in art.ts. */
import { type CSSProperties, useEffect, useRef, useSyncExternalStore } from "react";
import { noSubscription } from "@/components/no-subscription";
import { drawScene, drawSprite, drawStepChart, seedFrom, type SpriteName, type TextureKind, textureUrl } from "./art";

export function Sprite({ name, className }: { name: SpriteName; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawSprite(ref.current, name);
  }, [name]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

/** Procedural picture seeded by `seedKey` (e.g. a mint address). */
export function Scene({ seedKey, width, height, style }: { seedKey: string; width: number; height: number; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawScene(ref.current, seedFrom(seedKey));
  }, [seedKey]);
  return <canvas ref={ref} width={width} height={height} style={{ display: "block", width: "100%", height: "100%", ...style }} aria-hidden />;
}

export function StepChart({ values, color = "#80FF20" }: { values: number[]; color?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawStepChart(ref.current, values, color);
  }, [values, color]);
  return <canvas ref={ref} width={132} height={40} style={{ display: "block", width: "100%", height: "100%" }} aria-hidden />;
}

/** Textures are drawn once per kind+seed and reused; they never change. */
const textureCache = new Map<string, string>();
const cachedTexture = (kind: TextureKind, seed: number) => {
  const key = `${kind}:${seed}`;
  if (!textureCache.has(key)) textureCache.set(key, textureUrl(kind, seed));
  return textureCache.get(key) ?? "";
};

/** `background-image` for a noise texture. Empty on the server (textures need a canvas). */
export function useTexture(kind: TextureKind, seed = 1): CSSProperties {
  const url = useSyncExternalStore(noSubscription, () => cachedTexture(kind, seed), () => "");
  return url ? { backgroundImage: `url(${url})` } : {};
}

/** The XP-style graduation bar. `progress` is 0 to 1. */
export function XpBar({ progress, small, big, label }: { progress: number; small?: boolean; big?: boolean; label?: string }) {
  // Round down: "100%" only once the curve is really full (99.92% must not read as done).
  const percent = Math.floor(Math.min(Math.max(progress, 0), 1) * 100);
  const bar = (
    <div
      className={`xp${small ? " sm" : ""}${big ? " big" : ""}`}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Graduation progress"
    >
      <b style={{ width: `${percent}%` }} />
      <i />
    </div>
  );
  if (small) return bar;
  return (
    <div className="xpw">
      <div className="xpn num">{label ?? `${percent}%`}</div>
      {bar}
    </div>
  );
}
