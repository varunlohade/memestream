# Mainnet checklist

Every item needs the owner's explicit go. The DBC config is fixed once created on mainnet:
none of its parameters can change later, so all of them must be right first.

## Process (2026-10-08)
- From mainnet onward, a money change (tx builders, presets, fees, tx-flow) deploys only AFTER a fresh
  auditor reports it clean. On devnet, deploy-then-audit is acceptable.

## Decisions (the owner)
- [x] **Launch fee: 0.05 SOL** (the owner, 2026-10-08). `COIN_PRESETS["mainnet-beta"].launchFeeSol`,
      pinned in `config.test.ts`; `mainnet-config.surfpool.ts` proves a launch costs exactly 0.05 SOL
      more on the real program. It collects in each pool: the partner claims it with
      `claimPartnerPoolCreationFee` (a claim script is still to write). Go live shows
      "Launch costs 0.05 SOL" (read from the on-chain config). Devnet stays free.
- [x] **Graduated liquidity: 100% to the streamer, 0% to the partner** (the owner, 2026-10-09).
      `COIN_PRESETS["mainnet-beta"].lockedLpPercent`, pinned in `config.test.ts`;
      `mainnet-config.surfpool.ts` graduates a coin on the mainnet preset and proves exactly one
      position NFT exists, held by the streamer. The partner earns the 0.05 SOL launch fee and its
      20% share of curve fees. Devnet stays 50/50 (its config is fixed).
- [ ] **feeClaimer = a Squads multisig**, not a hot key (security audit). On mainnet the partner
      gets no LP position, so there are no partner LP fees to claim (on devnet, claim through the
      app, or for a multisig through Squads: audit #3, INFO-3).
- [x] **Graduation threshold: 3 SOL** (the owner, 2026-10-11; was 10 SOL). Set in
      `COIN_PRESETS["mainnet-beta"]`; `config.test.ts` pins it. Devnet uses 0.1 SOL, which the real
      programs accept, including graduation to DAMM v2 (lifecycle.surfpool.ts).
- [ ] **Partner wallet.** `feeClaimer` (receives memestream's 20% fee share) and
      `leftoverReceiver` (receives unsold tokens after graduation) must be the owner's real wallet,
      not a local key. `scripts/dev-chain.ts` uses `.keys/local-partner.json`: never use it on mainnet.
- [ ] **Fee settings.** Confirm: 50% launch fee falling to a 1% base over 60 s, plus a small
      volatility fee (`dynamicFeeEnabled: true`); 80% of fees to the streamer; graduated pool fee 1%
      (`MigrationFeeOption.FixedBps100`); 100% of graduated liquidity locked forever, all of it the
      streamer's (see above).
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
- [ ] Dry run: simulate the createConfig transaction and review it with the owner.
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

## Prediction markets: before mainnet

MEMESTREAM_MARKETS stays off on mainnet until every box is ticked (security audits 2026-10-12).

- [ ] **Admin paging:** a challenged, unresolved or AI-disputed market waits for an admin
      (MEMESTREAM_ADMIN_WALLETS). Page an admin at once and answer well under 24 hours; the 24-hour
      auto-void is the last resort only.
- [ ] **Void at cost basis:** a void now pays 0.5 SOL per share, whatever each share cost, so an
      underdog buyer profits. Refund each holder's cost basis instead, or let the proposal stand on
      timeout, before real money.
- [ ] **Scheduled sweep:** add the vercel.json cron for `/api/markets/close-due` (GET with
      `Authorization: Bearer $MEMESTREAM_CRON_SECRET`), so trading closes at lockAt with nobody watching.
- [ ] **MEMESTREAM_MARKET_SECRET never rotates:** it keys every question id and every pool's
      position NFT; a new secret loses the way to close and redeem every existing market.
- [ ] **External audit of the challenge economics:** bond size (100 points), the overturn reward,
      who may challenge and decide, and how a streamer or a mod could still profit from a result.
- [ ] **MetaDAO:** we only call its deployed conditional vault (BSL 1.1), never copy its source.
      Mint names (metadata) stay off on mainnet: MetaDAO lets only its deployer pay for them.
- [ ] **Legal review and geoblocking:** real-money prediction markets need a legal review and
      blocking where they aren't allowed, before any mainnet market opens.

## After
- [ ] Record the config address in the deploy env (`MEMESTREAM_CONFIG`) and in this file.
- [ ] Launch one test coin with a small first buy, then graduate-path smoke test with small amounts.
