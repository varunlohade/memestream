# memestream: handoff (2026-10-14)

Read this first in a new session. Everything below is current as of commit `acf473f` on `origin/main`.

## NEXT TASK (Varun, 2026-10-14): the AI resolves first, the streamer is the fallback

Varun's words: "let the ai check first if the said thing is true or not, if the ai doesnt say or
response to it, let the streamer decide the prediction market results".

Today the streamer resolves and the AI check is only a second opinion (a disagree goes to the admin). Change it to:
1. **AI first:** when betting closes, the server runs the AI check: stream frames → vision description → jev,
   asking whether it happened, YES or NO, at confidence ≥ 0.7 (the existing ai-check.ts pipeline). If the AI
   answers YES or NO, that is the PROPOSED result. It goes through the existing 2 h challenge window, and
   holders can still challenge. The card says "Proposed by AI: YES".
2. **Streamer fallback:** if the AI says UNCLEAR, fails, times out or has no frames (YouTube often has none),
   the streamer's Resolve Yes / No / Cancel buttons switch on, as today. The card says "AI couldn't tell, the
   streamer decides".
3. **Points-only predictions** follow the same rule.
4. **Keep:** the challenge window, the admin decision on disputes, the 24 h auto-void, and no early resolve.
5. **This is a money-path change** (it decides real-SOL market payouts). It needs tests, a fresh security
   audit (prompt-injection via stream content can now steer the result directly, so the challenge window and
   admin are the backstop), and UI previews (A/B/C) of the new card states before building the UI.

## Where things live

| What | Where |
|---|---|
| Live site (devnet) | https://www.memestream.lol (memestream.lol redirects to www) |
| Old link (shared with judges, KEEP) | https://memestream-iota.vercel.app redirects to the same page on www. Never delete this domain or the Vercel project. |
| Repo | github.com/varunlohade/memestream (private), branch `main` |
| Up-to-date working copy | `~/chat-coins/.claude/worktrees/release-predictions` (branch `release-predictions`, pushed as `main`) |
| Vercel project | team "varunlohade's projects", project `memestream` |
| Pitch deck (private artifact) | https://claude.ai/artifact/4MR1VDfwogE2dq83VsyogE |
| Test journeys page (private artifact) | https://claude.ai/artifact/597JtzSejT5K5J3FVCvNjG |
| Domain | memestream.lol, bought on Namecheap; DNS points at Vercel |

**Warning:** `~/chat-coins` itself (the main checkout) is STALE and has someone's uncommitted edits
(README.md, MAINNET-CHECKLIST.md, design/*, src/...). Don't build or deploy from it. Ask Varun before
discarding them.

## Deploy

Varun runs deploys himself (the agent is not allowed to):

```
cd ~/chat-coins/.claude/worktrees/release-predictions && git pull -q origin main; vercel deploy --prod --yes
```

Before pushing to main, run `npm run check`. In a fresh worktree, first run `npm ci` and
`NEXT_DIST_DIR=.next-check npx next typegen`, and copy `.cache` from `~/chat-coins-markets/.cache`,
which holds every program the surfpool tests need.

## What's live

- **Coins:** a coin per stream on Meteora DBC (devnet config `Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg`).
  - Graduation at 0.1 SOL on devnet, 3 SOL planned for mainnet.
  - Launch fee goes from 50% to 1% in 60 s. 80% of fees go to the streamer.
  - Graduation to DAMM v2, trading after graduation, LP fee claims.
- **UI:**
  - A pump.fun-style home: Live predictions row, king of the hill, tabs, search.
  - The coin page: big stream, Predictions tab first and open, chart inside the Trades tab, no ticker tape on coin pages.
  - A pump.fun-style trade box, a TradingView lightweight-charts chart, Solscan links, the logo and favicon.
- **Predictions:**
  - 1,000 free points on first sign-in (5 wallets per IP per day).
  - jev (TypeSafe) reviews every question server-side and also picks the betting window (1–60 min). There's no window picker in the UI.
  - Only the streamer or a mod launches. The other window removed crowd picks (commit 523528e).
  - Resolve is blocked until the window ends.
- **Markets (real devnet SOL):**
  - MetaDAO conditional vault plus one Meteora DAMM v2 YES/NO pool per market, using FPMM routing, so there's no bet cap.
  - Fee 0.3%: 80% to memestream's seed LP, 20% to Meteora.
  - 2 h challenge window. The admin decides disputes. 24 h auto-void.
  - Four security passes; verdict "devnet-safe". Mainnet blockers are in MAINNET-CHECKLIST.md.
- **Safety:**
  - A server-side double-pay check: 409 for an identical pending trade, no UI lock.
  - The AI check on results.
  - Hidden test coins.

## Settings (Vercel production env, names only)

`MEMESTREAM_PUBLIC_URL=https://www.memestream.lol` (wallet sign-in checks this host),
`MEMESTREAM_RPC_URL` (Helius devnet, secret), `MEMESTREAM_CONFIG`, `MEMESTREAM_WALLET_CHAIN`,
`MEMESTREAM_NETWORK_LABEL`, `MEMESTREAM_PREDICTIONS=1`, `MEMESTREAM_PREDICTIONS_SECRET`,
`MEMESTREAM_MARKETS=1`, `MEMESTREAM_MARKET_ORACLE` (6wVW…), `MEMESTREAM_MARKET_ORACLE_KEY` (secret),
`MEMESTREAM_MARKET_SECRET` (NEVER rotate, or existing markets are lost), `MEMESTREAM_MARKET_SEED_SOL=0.05`,
`MEMESTREAM_CRON_SECRET`, `MEMESTREAM_ADMIN_WALLETS` (BxfZ…6Enf), `MEMESTREAM_HIDDEN_CREATORS`
(our test wallets), `MEMESTREAM_HIDDEN_MINTS` (retake coins AIRPORTTRA, AIRPORTUK, AIRPORT2, AIRPORT3,
AIRPORT4), `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`, Upstash `KV_*`.

The agent can't write secrets to Vercel; Varun runs `vercel env add` himself. To hide another coin,
remove the env and add it back with the full comma list, then deploy.

## Wallets (public addresses; keys in `~/chat-coins/.keys/`, git-ignored)

- Partner / market oracle: `6wVWwYoF4gEP5mVMcTLYAhgNpvXpYTWcY8hdfi68m4o5` (.keys/partner.json), about 9 devnet SOL.
- Varun's streamer wallet: `2Uw2k8qUTTmdkigbLFZxM8bqKc1F4rwmnXYAeT7M5NAK`. Viewer and admin: `BxfZSzPDJVRyPrBQVDEJzgonQgHeVXJU34FAf2MQ6Enf`.
- Test creator `dave`: GxzcVEh8… (.keys/devnet-creator.json).
- Sim testers:
  - alice CKHsr55K…
  - bob D3eJNHum…
  - carol Bjw2rm4D…
  - (.keys/sim-*.json, about 0.3 SOL each)

## Sim testers (devnet only)

From the working copy above: `npx tsx scripts/sim.mts <cmd>`. The commands are fund, who, buy, sell,
signin, suggest, upvote, bet, sellbet, challenge, redeem, markets, golive, launch, resolve and graduate.
Each tester must hold at least 1 coin before suggesting or upvoting. A watcher script for retakes
(trade 5 min after a new coin appears, graduate 2 min later) is at
`/private/tmp/claude-501/-Users-varun/834da149-984c-4c71-bdab-a3e8f5e41c15/scratchpad/watch-new-coin.sh`,
in the old session's scratchpad. Copy it if needed.

## Open items

- **Submission:** the deadline was 2026-10-13 12:29 IST. Status unknown to this session; ask Varun.
  SUBMISSION.md was removed from main by another session.
- **Video:** Varun is recording the demo himself; the retakes used tickers AIRPORT*.
- **Mainnet:** needs Varun's go, the mainnet config, the MAINNET-CHECKLIST items (markets: admin paging,
  void at cost basis, scheduled close via `/api/markets/close-due` cron, external audit, legal review
  and geoblocking).
- **Later:** exact refunds on void, holders share market fees, the viewer jury, the 15-min window option.
- **Cleanup:** many old worktrees (`git worktree list`) can be removed once merged. They are all merged
  into main except `oracle-resolve` (~/chat-coins-invites) and `logo-b` (~/memestream-logo-b), which
  come from other sessions.

## Rules Varun set

- Short plain English (STE style).
- No sound without asking.
- Money changes need an audit.
- Never print keys.
- Only Varun's own Slack.
- Varun presses submit and deploy himself.
- Show UI previews (A/B/C) before building UI.

## From chat-coins-58

- **Oracle resolve (commit `a8e4756`, on main; deploy not confirmed):**
  - Only the memestream oracle resolves predictions. For now the oracle is Varun, by hand, as an admin in `MEMESTREAM_ADMIN_WALLETS`.
  - Streamers and mods can't resolve. After betting closes, they "witness": "It happened" or "It didn't", plus a note. This settles nothing. It only helps the admin and shows in disputes.
  - An admin who streams or mods the coin, or who bet on the prediction, can't resolve it.
  - Market pool fees (0.3%, to memestream's seed LP) are what pay for the oracle.
  - `scripts/predictions-e2e.mts` still resolves as the streamer, so it fails. Give it an admin wallet. `scripts/markets-e2e.mts` is updated.
- **Also on main:** crowd picks removed and the "Points are free..." note removed (`523528e`); no trade lock (`9ea3c02`, `156fd31`); the tagline "A prediction market for every live stream" (`5f5b1c3`).
- **Invite-only launches (NOT merged):**
  - Branch `invite-only` (`83e5f16`) has the first version.
  - Branch `wip/chat-coins-58` (`45b72df`) is a snapshot of every uncommitted edit in `~/chat-coins`. It holds a newer version of the invite work, plus README, MAINNET-CHECKLIST, design mocks and demo scripts. It is based on `d65b66d`, so it needs a rebase.
  - Rules: only a wallet in `MEMESTREAM_INVITES` (wallet:UCchannel) launches, and only on its own YouTube channel. The server seals the coin with `MEMESTREAM_VERIFY_SECRET`. Unverified coins cap buys at 0.1 SOL.
  - Needs `YOUTUBE_API_KEY`. `MEMESTREAM_OPEN_LAUNCH=1` lets anyone launch (ignored on mainnet).
- **Left out of git:** `~/chat-coins/demo/` videos, frames and stills (2.5 GB), and `demo/flows/.env.market-secret.local` (a secret). They stay on disk only.
- **`~/chat-coins-invites`** (branch `oracle-resolve`) is now merged into main, so it can be removed.
- **Colosseum Copilot** is connected (macOS keychain).
