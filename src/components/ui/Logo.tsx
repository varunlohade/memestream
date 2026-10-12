/** The memestream logo: a gold pixel coin with a red LIVE badge on stone. Same art as the favicon and app icons in src/app. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny static pixel art; next/image adds nothing here
    <img src="/logo.png" width={size} height={size} alt="" aria-hidden="true" className="logo" style={{ imageRendering: "pixelated" }} />
  );
}
