import type { CoinStatus } from "@/lib/api-types";

/** "Live" over a coin's stream picture, or "Graduated" once it trades on Meteora. */
export function LiveBadge({ status }: { status: CoinStatus }) {
  const graduated = status === "graduated";
  return <span className={`live${graduated ? " grad" : ""}`}>{graduated ? "Graduated" : "Live"}</span>;
}
