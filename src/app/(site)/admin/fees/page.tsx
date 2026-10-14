import type { Metadata } from "next";
import { PartnerFeesView } from "@/components/admin/PartnerFeesView";

// Admin tool: kept out of search results. The API checks the signed-in wallet is an admin.
export const metadata: Metadata = { title: "Partner fees", robots: { index: false, follow: false } };

export default function PartnerFees() {
  return <PartnerFeesView />;
}
