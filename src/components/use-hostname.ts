"use client";
import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};
/** The page's hostname (Twitch embeds need it); null during server render, so no hydration mismatch. */
export const useHostname = () => useSyncExternalStore(noSubscription, () => window.location.hostname, () => null);
