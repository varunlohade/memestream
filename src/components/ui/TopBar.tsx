"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Sprite, useTexture } from "@/components/pixel/Pixel";
import { useSearch } from "@/components/search";
import { useWallet } from "@/components/wallet/WalletProvider";
import { shortAddress } from "@/lib/format";
import { PageTexture } from "./PageTexture";

/** Wallet chip with a disclosure panel: pick a wallet to connect, or disconnect. */
function WalletMenu() {
  const { address, options, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={root} style={{ position: "relative" }}>
      <button
        type="button"
        className="wallet"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={address ? `Wallet ${shortAddress(address)}` : "Connect wallet"}
        onClick={() => setOpen(!open)}
      >
        <Sprite name="heart" />
        <span className="num">{address ? shortAddress(address) : "Connect"}</span>
      </button>
      {open && (
        <div id={panelId} className="p wallet-panel">
          {address ? (
            <>
              <p className="num" style={{ fontSize: 22, wordBreak: "break-all" }}>{address}</p>
              <button
                type="button"
                className="mbtn"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </button>
            </>
          ) : (
            <>
              {options.length === 0 && <p style={{ fontSize: 22 }}>No Solana wallet found. Install Phantom or Solflare.</p>}
              {options.map((option) => (
                <button
                  type="button"
                  key={option.name}
                  className="mbtn"
                  onClick={async () => {
                    setError(null);
                    try {
                      await option.connect();
                      setOpen(false);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  {option.name}
                </button>
              ))}
            </>
          )}
          {error && <p className="notice err" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

/** Filters the home board by ticker or name; typing on another page goes to the board. */
function SearchBox() {
  const { query, setQuery } = useSearch();
  const router = useRouter();
  return (
    <input
      type="search"
      className="slot search"
      placeholder="search token"
      aria-label="Search coins by ticker or name"
      value={query}
      onChange={(e) => {
        setQuery(e.target.value);
        // Read on the event, not via usePathname: the top bar must not block prerendering.
        if (window.location.pathname !== "/") router.push("/");
      }}
    />
  );
}

export function TopBar({ network }: { network: string }) {
  const texture = useTexture("deep", 2);
  return (
    <header className="top" style={texture}>
      <PageTexture />
      <Link href="/" className="brand" aria-label="memestream home">
        <Sprite name="coin" />
        <span className="wm">memestream</span>
        <span className="net">{network}</span>
      </Link>
      <SearchBox />
      <div className="top-actions">
        <Link href="/go-live" className="mbtn buy go-live">
          Go live
        </Link>
        <WalletMenu />
      </div>
    </header>
  );
}
