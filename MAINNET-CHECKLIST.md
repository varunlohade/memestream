# Mainnet checklist

Every item needs Boss man's explicit go. The DBC config is fixed once created on mainnet:
none of its parameters can change later, so all of them must be right first.

## Process (steve, 2026-10-08)
- From mainnet onward, a money change (tx builders, presets, fees, tx-flow) deploys only AFTER a fresh
  auditor reports it clean. On devnet, deploy-then-audit is acceptable.

## Decisions (Boss man)
- [x] **Launch fee: 0.05 SOL** (Boss man, 2026-10-08, via steve). `COIN_PRESETS["mainnet-beta"].launchFeeSol`,
      pinned in `config.test.ts`; `mainnet-config.surfpool.ts` proves a launch costs exactly 0.05 SOL
      more on the real program. It collects in each pool: the partner claims it with
      `claimPartnerPoolCreationFee` (a claim script is still to write). Go live shows
      "Launch costs 0.05 SOL" (read from the on-chain config). Devnet stays free.
- [ ] **feeClaimer = a Squads multisig**, not a hot key (security audit). It also receives the
      partner's locked LP position.
- [x] **Graduation threshold: 10 SOL** (Boss man, 2026-10-08, via steve). Set in
      `COIN_PRESETS["mainnet-beta"]`; `config.test.ts` pins it. Devnet uses 0.1 SOL, which the real
      programs accept, including graduation to DAMM v2 (lifecycle.surfpool.ts).
- [ ] **Partner wallet.** `feeClaimer` (receives memestream's 20% fee share) and
      `leftoverReceiver` (receives unsold tokens after graduation) must be Boss man's real wallet,
      not a local key. `scripts/dev-chain.ts` uses `.keys/local-partner.json`: never use it on mainnet.
- [ ] **Fee settings.** Confirm: 50% launch fee falling to a 1% base over 60 s, plus a small
      volatility fee (`dynamicFeeEnabled: true`); 80% of fees to the streamer; graduated pool fee 1%
      (`MigrationFeeOption.FixedBps100`); 100% of graduated liquidity locked forever.
- [ ] **Public URL.** `MEMESTREAM_PUBLIC_URL` is baked into every coin's on-chain metadata URI and
      can never change for coins already launched. Set it to the final domain (e.g. https://memestream.lol).
      Devnet runs on the *.vercel.app URL for now; buy the domain before mainnet.

## Before creating the config
- [x] Full path on real **devnet** once: create, buy, sell, graduate, claim. Done 2026-10-08 through
      the live site's API (`scripts/devnet-pass.mts`): coin $DVZ7PP78
      2b9qebcq1xN8kW2MCL51mfcWBoFMqpKFEuMY2vmF79CC, graduate tx
      3KU5oytsRphp6GSt65Ge2c34KVYeEoiSZaJ5KMtTqA4uZY7jNpdKw8S8LZ6UEJEwsYKUKdJJbAyf5AeKJmsMiQwk.
- [ ] Paid RPC (Helius/QuickNode/Triton) in `MEMESTREAM_RPC_URL`. The coin list uses
      getProgramAccounts, which public RPCs rate-limit.
- [ ] `MEMESTREAM_WALLET_CHAIN=solana:mainnet` and `MEMESTREAM_NETWORK_LABEL=Mainnet`.
- [ ] Priority fees on transactions (busy mainnet drops unprioritized ones).
- [ ] Dry run: simulate the createConfig transaction and review it with Boss man.
- [ ] Production build has **no** `MEMESTREAM_DEV_WALLET_KEY` set (the test wallet must not exist).

- [x] Shared rate limits (2026-10-08): per-client limits per route and the site-wide RPC budget live in
      Upstash Redis (`src/server/shared-limit.ts`, `rpc-budget.ts`), shared by every Vercel instance.
      Without Redis, or if it's down, each instance falls back to in-memory buckets (30 s pause).
      [x] Upstash Redis installed (2026-10-08, "memestream-limits", free plan) and verified live:
          right after live requests Redis holds `memestream:client:<route>` and
          `memestream:rpc-budget:all` (keys expire once a bucket refills).
      [ ] Set the RPC budget (now 300 burst / 60 calls/s) from the paid RPC plan.
- [x] Vercel Firewall (2026-10-08): rule "Per-IP limit: whole site", 300 requests/min per IP on
      everything except /_next/static, published. Hobby allows one rate-limit rule; Pro allows more
      (e.g. a stricter /api/tx rule).
      `/api/tx/status` allows no-Origin requests (browsers omit Origin on same-origin GETs).
- [x] Client IP: `clientIp()` prefers `x-vercel-forwarded-for` / `x-real-ip` (set by Vercel's edge)
      over the forgeable `x-forwarded-for`. The global RPC budget stays the hard cap. Every API route that reaches the chain goes through
      `withRpcGuard` (`src/server/rpc-guard.ts`; enforced by `src/server/api-guard.test.ts`).
      Set the shared budget (`takeRpcBudget`, now 300 burst / 60 calls/s) from the paid RPC plan,
      and review each route's per-client limit and call cost for real traffic.
- [x] Per-IP limit in front of the server-rendered pages too: the firewall rule above covers
      `/coin/*`, `/overlay/*` and `/<ticker>`. Junk coin addresses cost 1 RPC call each (cached 30 s).
- [ ] Known MVP limit (money): a wallet popup left open past the unlock window (or in a tab
      closed for 10+ minutes) can still be signed after the user unlocks. Our server-built
      transactions can't land after their blockhash expires, so this only affects wallets that
      swap in a fresh blockhash. Users are told to reject open popups before unlocking.

- [ ] **npm advisories** (audit #2, 2026-10-08): `npm audit --omit=dev` lists 13 (6 high), all
      transitive through @solana/web3.js v1, @solana/spl-token and the Meteora DBC SDK (bigint-buffer,
      toml, stream-json, uuid, jayson); no fix available upstream. Our server feeds them only our own
      RPC's responses and our own transaction bytes. Re-check before mainnet and bump when the SDK does.

## After
- [ ] Record the config address in the deploy env (`MEMESTREAM_CONFIG`) and in this file.
- [ ] Launch one test coin with a small first buy, then graduate-path smoke test with small amounts.
