# Mainnet checklist

Every item needs Boss man's explicit go. The DBC config is fixed once created on mainnet:
none of its parameters can change later, so all of them must be right first.

## Decisions (Boss man)
- [ ] **Graduation threshold.** `COIN_PRESETS["mainnet-beta"].graduationThresholdSol` in
      `src/lib/dbc/preset.ts` is a placeholder ("85"). Pick the real number. Devnet uses "1.5".
- [ ] **Partner wallet.** `feeClaimer` (receives memestream's 20% fee share) and
      `leftoverReceiver` (receives unsold tokens after graduation) must be Boss man's real wallet,
      not a local key. `scripts/dev-chain.ts` uses `.keys/local-partner.json`: never use it on mainnet.
- [ ] **Fee settings.** Confirm: 50% launch fee falling to a 1% base over 60 s, plus a small
      volatility fee (`dynamicFeeEnabled: true`); 80% of fees to the streamer; graduated pool fee 1%
      (`MigrationFeeOption.FixedBps100`); 100% of graduated liquidity locked forever.
- [ ] **Public URL.** `MEMESTREAM_PUBLIC_URL` is baked into every coin's on-chain metadata URI and
      can never change for coins already launched. Set it to the final domain (e.g. https://memestream.lol).

## Before creating the config
- [ ] Full path on real **devnet** once: create, buy, sell, graduate, claim (needs faucet SOL).
- [ ] Paid RPC (Helius/QuickNode/Triton) in `MEMESTREAM_RPC_URL`. The coin list uses
      getProgramAccounts, which public RPCs rate-limit.
- [ ] `MEMESTREAM_WALLET_CHAIN=solana:mainnet` and `MEMESTREAM_NETWORK_LABEL=Mainnet`.
- [ ] Priority fees on transactions (busy mainnet drops unprioritized ones).
- [ ] Dry run: simulate the createConfig transaction and review it with Boss man.
- [ ] Production build has **no** `MEMESTREAM_DEV_WALLET_KEY` set (the test wallet must not exist).

- [ ] Rate limits on the API (`src/server/rate-limit.ts`): they're in-memory per server instance.
      On a multi-instance host (e.g. serverless), move them to a shared store (Redis/Upstash) or the
      host's firewall rules, and set the global RPC budget from the paid RPC plan's limits.
      `/api/tx/status` allows no-Origin requests (browsers omit Origin on same-origin GETs).
- [ ] Client IP for the per-client limit: `x-forwarded-for` is set by the client unless a trusted
      proxy overwrites it. On deploy, key the bucket on the platform's real client IP (e.g. Vercel's
      `x-vercel-forwarded-for` / `x-real-ip` set by the edge) in `clientIp()`, and treat the global
      RPC budget as the hard cap. Every API route that reaches the chain goes through
      `withRpcGuard` (`src/server/rpc-guard.ts`; enforced by `src/server/api-guard.test.ts`).
      Set the shared budget (`takeRpcBudget`, now 300 burst / 60 calls/s) from the paid RPC plan,
      and review each route's per-client limit and call cost for real traffic.
- [ ] A host firewall / per-IP rate limit in front of the server-rendered pages too (`/coin/*`,
      `/overlay/*`), not just the API: they share the RPC budget, so a flood of page loads could
      make real users see "busy". Junk coin addresses cost 1 RPC call each (cached 30 s).
- [ ] Known MVP limit (money): a wallet popup left open past the unlock window (or in a tab
      closed for 10+ minutes) can still be signed after the user unlocks. Our server-built
      transactions can't land after their blockhash expires, so this only affects wallets that
      swap in a fresh blockhash. Users are told to reject open popups before unlocking.

## After
- [ ] Record the config address in the deploy env (`MEMESTREAM_CONFIG`) and in this file.
- [ ] Launch one test coin with a small first buy, then graduate-path smoke test with small amounts.
