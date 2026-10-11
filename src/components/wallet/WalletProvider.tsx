"use client";
/**
 * Wallet connection via the Wallet Standard (Phantom, Solflare, Backpack...), plus a
 * localhost-only test wallet. The browser never builds transactions: the server returns
 * bytes and the wallet signs and sends them.
 */
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionFeature,
  SolanaSignIn,
  type SolanaSignInFeature,
  type SolanaSignInInput,
  SolanaSignMessage,
  type SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import { getWallets } from "@wallet-standard/app";
import type { IdentifierString, Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  type StandardConnectFeature,
  StandardDisconnect,
  type StandardDisconnectFeature,
  StandardEvents,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import bs58 from "bs58";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson, postJson } from "@/lib/http";

export type WalletOption = { name: string; icon?: string; connect: (silent?: boolean) => Promise<void> };

type WalletState = {
  address: string | null;
  options: WalletOption[];
  disconnect: () => void;
  /**
   * Signs and sends base64 transaction bytes; resolves to the signature once sent (not confirmed).
   * Throws "Connect a wallet first" without opening any prompt if no wallet is connected.
   */
  signAndSend: (base64Tx: string) => Promise<string>;
  /** The app's cluster as a Wallet Standard id, e.g. "solana:devnet" (read-only; for links). */
  chain: IdentifierString;
  /**
   * Signs a Sign-In-With-Solana message, never a transaction (used only to sign in to free-points
   * predictions). Uses the wallet's own sign-in (`solana:signIn`) when it has one, so the wallet
   * builds the text and checks the domain against this page; otherwise signs `message` (the same
   * text) with `solana:signMessage`. Resolves to the exact bytes signed and the 64-byte signature.
   * Null if the connected wallet can do neither.
   */
  signIn: ((input: SolanaSignInInput, message: Uint8Array) => Promise<{ signedMessage: Uint8Array; signature: Uint8Array }>) | null;
};

const DEV_WALLET_NAME = "Test wallet (localhost)";

/** Remembers the chosen wallet so a page reload reconnects quietly. A per-viewer convenience only. */
const REMEMBER_KEY = "memestream.wallet";
const remembered = {
  get: () => {
    try {
      return localStorage.getItem(REMEMBER_KEY);
    } catch {
      return null;
    }
  },
  set: (name: string | null) => {
    try {
      if (name) localStorage.setItem(REMEMBER_KEY, name);
      else localStorage.removeItem(REMEMBER_KEY);
    } catch {
      // storage blocked: reconnecting by hand still works
    }
  },
};

const WalletContext = createContext<WalletState | null>(null);

export function useWallet(): WalletState {
  const state = useContext(WalletContext);
  if (!state) throw new Error("useWallet must be used inside WalletProvider");
  return state;
}

const base64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

type SolanaWallet = Wallet & {
  features: StandardConnectFeature &
    SolanaSignAndSendTransactionFeature &
    Partial<StandardDisconnectFeature & StandardEventsFeature>;
};

/** Wallets that can connect, sign-and-send, and run on the app's cluster. */
const supports = (chain: IdentifierString) => (wallet: Wallet): wallet is SolanaWallet =>
  StandardConnect in wallet.features && SolanaSignAndSendTransaction in wallet.features && wallet.chains.includes(chain);

type Active = { kind: "standard"; wallet: SolanaWallet; account: WalletAccount } | { kind: "dev"; address: string };

/** `chain` is the Wallet Standard id of the server's cluster, e.g. "solana:devnet" (set in layout from server config). */
export function WalletProvider({ chain, children }: { chain: IdentifierString; children: ReactNode }) {
  const [wallets, setWallets] = useState<SolanaWallet[]>([]);
  const [devAvailable, setDevAvailable] = useState(false);
  const [active, setActive] = useState<Active | null>(null);
  /** Bumped on disconnect, so connects started before it can't reconnect the wallet. */
  const session = useRef(0);
  /** Remembered wallets already tried for a quiet reconnect this page load. */
  const tried = useRef(new Set<string>());

  useEffect(() => {
    const registry = getWallets();
    const refresh = () => setWallets(registry.get().filter(supports(chain)));
    const offRegister = registry.on("register", refresh);
    const offUnregister = registry.on("unregister", refresh);
    refresh();
    return () => {
      offRegister();
      offUnregister();
    };
  }, [chain]);

  useEffect(() => {
    if (!["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
    fetchJson("/api/dev-wallet")
      .then(() => setDevAvailable(true))
      .catch(() => setDevAvailable(false));
  }, []);

  // Follow account switches and disconnects made inside the wallet itself.
  useEffect(() => {
    if (active?.kind !== "standard") return;
    const events = active.wallet.features[StandardEvents];
    if (!events) return;
    return events.on("change", ({ accounts }) => {
      if (!accounts) return;
      const account = accounts.find((a) => a.chains.includes(chain));
      if (account) setActive({ kind: "standard", wallet: active.wallet, account });
      else {
        remembered.set(null);
        setActive(null);
      }
    });
  }, [active, chain]);

  const options = useMemo<WalletOption[]>(() => {
    const standard = wallets.map((wallet) => ({
      name: wallet.name,
      icon: wallet.icon,
      connect: async (silent = false) => {
        const startedIn = session.current;
        const { accounts } = await wallet.features[StandardConnect].connect({ silent });
        if (silent && session.current !== startedIn) return; // user disconnected meanwhile
        const account = accounts.find((a) => a.chains.includes(chain));
        if (!account) throw new Error(`${wallet.name} has no account on this network`);
        setActive({ kind: "standard", wallet, account });
        remembered.set(wallet.name);
      },
    }));
    if (!devAvailable) return standard;
    const dev: WalletOption = {
      name: DEV_WALLET_NAME,
      connect: async (silent = false) => {
        const startedIn = session.current;
        const { address } = await fetchJson<{ address: string }>("/api/dev-wallet");
        if (silent && session.current !== startedIn) return;
        setActive({ kind: "dev", address });
        remembered.set(DEV_WALLET_NAME);
      },
    };
    return [...standard, dev];
  }, [wallets, devAvailable, chain]);

  // Quietly reconnect the remembered wallet once it shows up. Silent connect never prompts.
  // One attempt per wallet name; a disconnect bumps the session so a late result is ignored.
  useEffect(() => {
    if (active) return;
    const name = remembered.get();
    const option = options.find((o) => o.name === name);
    if (!name || !option || tried.current.has(name)) return;
    tried.current.add(name);
    const startedIn = session.current;
    option.connect(true).catch(() => {
      if (session.current === startedIn) remembered.set(null); // the wallet is here and said no
    });
  }, [active, options]);

  const disconnect = useCallback(() => {
    session.current++;
    if (active?.kind === "standard") void active.wallet.features[StandardDisconnect]?.disconnect();
    remembered.set(null);
    setActive(null);
  }, [active]);

  const signAndSend = useCallback(
    async (base64Tx: string): Promise<string> => {
      if (!active) throw new Error("Connect a wallet first");
      if (active.kind === "dev") {
        return (await postJson<{ signature: string }>("/api/dev-wallet", { transaction: base64Tx })).signature;
      }
      const [result] = await active.wallet.features[SolanaSignAndSendTransaction].signAndSendTransaction({
        account: active.account,
        chain,
        transaction: base64ToBytes(base64Tx),
      });
      return bs58.encode(result.signature);
    },
    [active, chain],
  );

  const signIn = useMemo(() => {
    if (active?.kind !== "standard") return null;
    const features = active.wallet.features as Partial<SolanaSignInFeature & SolanaSignMessageFeature>;
    const signInFeature = features[SolanaSignIn];
    const signMessageFeature = features[SolanaSignMessage];
    if (signInFeature) {
      return async (input: SolanaSignInInput) => {
        const [output] = await signInFeature.signIn(input);
        if (output.account.address !== active.account.address) throw new Error("Sign in with the connected account");
        if (output.signedMessageFormat) throw new Error("This wallet signed in a format we can't check");
        return { signedMessage: output.signedMessage, signature: output.signature };
      };
    }
    if (!signMessageFeature) return null;
    return async (_input: SolanaSignInInput, message: Uint8Array) => {
      const [output] = await signMessageFeature.signMessage({ account: active.account, message });
      return { signedMessage: message, signature: output.signature };
    };
  }, [active]);

  const address = active ? (active.kind === "dev" ? active.address : active.account.address) : null;
  const value = useMemo(
    () => ({ address, options, disconnect, signAndSend, chain, signIn }),
    [address, options, disconnect, signAndSend, chain, signIn],
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
