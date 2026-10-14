# Mainnet checklist

Every item needs the owner's explicit go. The DBC config is fixed once created on mainnet:
none of its parameters can change later, so all of them must be right first.

## Process (2026-10-08)
- From mainnet onward, a money change (tx builders, presets, fees, tx-flow) deploys only AFTER a fresh
  auditor reports it clean. On devnet, deploy-then-audit is acceptable.

The owner's step-by-step for launch day is in RUNBOOK-mainnet.md.

## Decisions (the owner)
- [x] **Scope (the owner, 2026-10-15):** mainnet = coins (DBC) + free-points predictions. Real-SOL
      prediction markets are OFF on mainnet. `marketsEnabled()` is false whenever
      `MEMESTREAM_WALLET_CHAIN=solana:mainnet`, even with `MEMESTREAM_MARKETS=1`
      (`src/server/predictions/flag.ts`, test `src/server/mainnet-guards.test.ts`).
- [x] **Launch fee: 0.05 SOL** (the owner, 2026-10-08). `COIN_PRESETS["mainnet-beta"].launchFeeSol`,
      pinned in `config.test.ts`; `mainnet-config.surfpool.ts` proves a launch costs exactly 0.05 SOL
      more on the real program. It collects in each pool; memestream gets 90% (0.045 SOL), Meteora 10%.
      Claim it with `scripts/claim-partner-fees.mts` or the admin page `/admin/fees` (2026-10-15,
      `partner-fees.surfpool.ts`). Go live shows "Launch costs 0.05 SOL" (read from the on-chain
      config). Devnet stays free.
- [x] **Graduated liquidity: 100% to the streamer, 0% to the partner** (the owner, 2026-10-09).
      `COIN_PRESETS["mainnet-beta"].lockedLpPercent`, pinned in `config.test.ts`;
      `mainnet-config.surfpool.ts` graduates a coin on the mainnet preset and proves exactly one
      position NFT exists, held by the streamer. The partner earns the 0.05 SOL launch fee and its
      20% share of curve fees. Devnet stays 50/50 (its config is fixed).
- [x] **feeClaimer: the owner's own wallet, NOT a multisig** (the owner's choice, 2026-10-15; the
      security audit asked for a Squads multisig). RISK, accepted by the owner: one browser wallet
      controls memestream's fee share and launch fees forever (the config can't change). If that
      wallet's key leaks, the thief can claim all unclaimed partner fees, now and later. Keep its
      seed phrase offline, claim often so little sits unclaimed, and never import it into a hot
      server. On mainnet the partner gets no LP position, so there are no partner LP fees to claim.
- [x] **Graduation threshold: 3 SOL** (the owner, 2026-10-11; was 10 SOL). Set in
      `COIN_PRESETS["mainnet-beta"]`; `config.test.ts` pins it. Devnet uses 0.1 SOL, which the real
      programs accept, including graduation to DAMM v2 (lifecycle.surfpool.ts).
- [x] **Partner wallet** (the owner, 2026-10-15). `feeClaimer` (memestream's fee share and launch
      fees) and `leftoverReceiver` (unsold tokens after graduation) are both the owner's wallet
      `BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf` (`MAINNET_PARTNER_WALLET` in `preset.ts`, pinned
      in `config.test.ts`; `mainnet-config.surfpool.ts` reads both back from a created config).
      `scripts/dev-chain.ts` uses `.keys/local-partner.json`: never use it on mainnet.
- [x] **Fee settings kept as is** (the owner, 2026-10-15): 50% launch fee falling to a 1% base over
      60 s, plus a small volatility fee (`dynamicFeeEnabled: true`); 80% of fees to the streamer;
      graduated pool fee 1% (`MigrationFeeOption.FixedBps100`); 100% of graduated liquidity locked
      forever, all of it the streamer's; launch fee 0.05 SOL; graduation 3 SOL. All pinned in
      `config.test.ts`. Note: Meteora takes 20% of every trading fee first (PROTOCOL_FEE_PERCENT);
      the 80/20 split is of the rest, so per trading fee: streamer 64%, memestream 16%, Meteora 20%.
- [x] **Public URL** (the owner, 2026-10-15). Mainnet: `MEMESTREAM_PUBLIC_URL=https://www.memestream.lol`
      (baked into every mainnet coin's metadata URI forever). Devnet moves to
      https://devnet.memestream.lol (a second Vercel project). memestream-iota.vercel.app keeps
      redirecting to www (`next.config.ts`; never remove it). On mainnet the build refuses a public
      URL that isn't an https origin (`src/lib/network.ts`).

## Before creating the config
- [x] Full path on real **devnet** once: create, buy, sell, graduate, claim. Done 2026-10-08 through
      the live site's API (`scripts/devnet-pass.mts`): coin $DVZ7PP78
      2b9qebcq1xN8kW2MCL51mfcWBoFMqpKFEuMY2vmF79CC, graduate tx
      3KU5oytsRphp6GSt65Ge2c34KVYeEoiSZaJ5KMtTqA4uZY7jNpdKw8S8LZ6UEJEwsYKUKdJJbAyf5AeKJmsMiQwk.
- [ ] Paid RPC (Helius/QuickNode/Triton) in `MEMESTREAM_RPC_URL`. The coin list uses
      getProgramAccounts, which public RPCs rate-limit.
- [ ] `MEMESTREAM_WALLET_CHAIN=solana:mainnet` (the owner sets it; RUNBOOK-mainnet.md). This one value
      is the mainnet switch: it forces the label "Mainnet", markets off, and Solscan links without
      `?cluster=` (2026-10-15). A mainnet RPC URL with any other wallet chain stops the build, and
      before building any transaction the server compares the RPC's genesis hash with the wallet
      chain and refuses on a mismatch (`src/server/prepare-tx.ts`).
- [x] Priority fees on transactions (2026-10-15). Every server-built transaction (launch, buy, sell,
      graduate, streamer and LP fee claims, market bets and redeems, the oracle's own sends, partner
      claims, the config script) gets a compute unit limit from a simulation (+20% + 10k CU; 400k if
      the simulation fails) and a price at the 75th percentile of `getRecentPrioritizationFees` on
      its writable accounts, between 10,000 and `MEMESTREAM_PRIORITY_FEE_MAX` (default 1,000,000)
      micro-lamports per CU: at most ~0.0004 SOL per 400k-CU transaction. `src/lib/priority-fee.ts`,
      `src/server/prepare-tx.ts`; tests `priority-fee.test.ts`, `server-trade.surfpool.ts` (launch,
      buy, sell and graduate land with it). The double-pay hold is unchanged (it keys on the request,
      not the bytes).
- [ ] Dry run: simulate the createConfig transaction and review it with the owner.
      Done by the agent 2026-10-15 on public mainnet (`scripts/mainnet-config.mts`, payer = the
      owner's wallet, throwaway config key): simulation OK, 37,642 CU, payer cost ~0.006 SOL. The
      owner still runs it himself and reviews the printout before `--send`.
- [x] Production build has **no** `MEMESTREAM_DEV_WALLET_KEY` (2026-10-15): with the mainnet wallet
      chain, `next build`, `next start` (`next.config.ts`) and the first chain access
      (`src/server/chain.ts`) throw if it is set (`src/lib/network.test.ts`).
- [x] Hidden-coin lists are per deployment (2026-10-15): `MEMESTREAM_HIDDEN_CREATORS` and
      `MEMESTREAM_HIDDEN_MINTS` are env only; no address is hard-coded. Mainnet starts with both
      empty; never copy devnet's values (RUNBOOK-mainnet.md).

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
      Re-checked 2026-10-15: 46 (13 low, 19 moderate, 14 high, 0 critical). The rise comes mostly from
      `@metadaoproject/futarchy` (markets; added after audit #2), which pulls in bundlr/arbundles,
      axios, @sqds/multisig, elliptic and an old `ws`. The rest are the same web3.js v1 / spl-token /
      Meteora SDK chains (bigint-buffer, toml, stream-json, uuid, bn.js). Only `ws` (under
      @ethersproject/providers, via arbundles) has a non-breaking fix (`npm audit fix`); not applied
      here. Markets are off on mainnet, so the futarchy paths never run there, but the package is
      still in the server bundle. Decide before mainnet: apply `npm audit fix`, and consider loading
      the markets code only when markets are on.

## Prediction markets: before mainnet

MEMESTREAM_MARKETS stays off on mainnet until every box is ticked (security audits 2026-10-12).
Since 2026-10-15 the code enforces it: markets are off whenever the wallet chain is mainnet.

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
- [ ] Claim partner fees once from `/admin/fees` (the owner's wallet signs) and check the SOL arrives.
