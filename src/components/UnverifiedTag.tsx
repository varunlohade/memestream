"use client";
/**
 * The "Unverified" tag (design A): nobody has checked that the launcher owns the stream's channel
 * (channel sign-in comes later). On a tile it's a plain tag with a hover note; on the coin page a
 * tap opens the note too, since phones have no hover.
 */
import { useState } from "react";

export const UNVERIFIED_NOTE = "We haven't checked that this streamer owns the channel.";

export function UnverifiedTag({ tappable = false }: { tappable?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!tappable) {
    return (
      <span className="unv" title={UNVERIFIED_NOTE}>
        Unverified
      </span>
    );
  }
  return (
    <span className="unv-wrap">
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
