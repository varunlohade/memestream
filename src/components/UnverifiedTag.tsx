"use client";
/**
 * The "Unverified" tag (design A): nobody has checked that the launcher owns the stream's channel
 * (channel sign-in comes later). On a tile it's a plain tag with a hover note; on the coin page a
 * tap opens the note too, since phones have no hover.
 */
import { useEffect, useRef, useState } from "react";

export const UNVERIFIED_NOTE = "We haven't checked that this streamer owns the channel.";

export function UnverifiedTag({ tappable = false }: { tappable?: boolean }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  // An open note closes on a tap outside it or on Escape (a second tap on the tag closes it too).
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => !wrap.current?.contains(event.target as Node) && setOpen(false);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  if (!tappable) {
    return (
      <span className="unv" title={UNVERIFIED_NOTE}>
        Unverified
      </span>
    );
  }
  return (
    <span className="unv-wrap" ref={wrap}>
      <button type="button" className="unv" title={UNVERIFIED_NOTE} aria-expanded={open} onClick={() => setOpen(!open)}>
        Unverified
      </button>
      {open && (
        <span className="unv-note" role="note">
          {UNVERIFIED_NOTE}
        </span>
      )}
    </span>
  );
}
