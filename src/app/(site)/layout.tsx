import { TxBanner, TxProvider } from "@/components/tx";
import { TopBar } from "@/components/ui/TopBar";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { networkInfo } from "@/server/chain";

/** The website: wallet, money flow, top bar. (The OBS overlay lives outside this group, bare.) */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  // One source of truth for the cluster: the server's settings feed both label and wallet chain.
  const network = networkInfo();
  return (
    <WalletProvider chain={network.walletChain}>
      <TxProvider>
        <TopBar network={network.label} />
        <TxBanner />
        <main>{children}</main>
      </TxProvider>
    </WalletProvider>
  );
}
