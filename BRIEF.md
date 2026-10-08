# memestream (memestream.lol): brief (2026-10-07). Earlier names: "Chat Coins", "Streammmmmmmmmmmmmmmmmmm".

## Goal
Win Superteam "Best use of Meteora DBC" (https://superteam.fun/earn/listing/meteora-dbc).
$20k USDC, 1st = $10k. Deadline 2026-10-31.
Judges want: DBC at the core, live on mainnet, real users, new idea. Open source preferred.

## Repo
Private GitHub repo (Boss man, 2026-10-07). Before submit: give read access to "dannxbt" (bounty rule for closed source).

## Product
A token for every live stream, launched on Meteora's Dynamic Bonding Curve (DBC).
- A streamer goes live and launches a coin for that stream in one tap.
- Viewers buy when they think the stream will pop. The price is a live hype meter.
- The streamer earns a share of every trade fee (DBC creator fee).
- When enough money flows in, the coin graduates to a Meteora DAMM v2 pool. That is the "stream went viral" moment.
- App rule (memestream's server and UI, not on-chain): the streamer's wallet can't buy its own coin here. Streamers earn from fees, not trades. Another wallet can still buy via DBC directly.
- No YES/NO bets (no settlement in DBC, gambling risk).

## Competition (scan 2026-10-07)
~80 DBC repos. Crowded: curve designers (~30), stock launchpads (~15), risk checkers (~10). No live-stream entry.
Outside the bounty: Pump.fun live + streamer coins; CRSHMARKET, Polymarket, Kalshi stream bets.

## Plan
- Week 1 (Oct 7–13): curve preset + launch flow on DEVNET. Simple web app: connect wallet, go live (create coin), buy, sell, see price + graduation progress.
- Week 2 (Oct 14–20): OBS overlay (price + graduation bar). Move to mainnet.
- Week 3 (Oct 21–27): 3–5 small streamers use it live.
- Oct 28–31: demo video, README, submit.

## Week 1 tech (proposal)
- Next.js + TypeScript web app, Solana wallet adapter (Phantom etc.).
- @meteora-ag/dynamic-bonding-curve-sdk 1.5.13. Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN (same on devnet).
- One partner config key ("Chat Coins preset"): SOL quote, short-stream curve, anti-sniper fee at launch (50% → 1% base + small volatility fee), creator fee share, DAMM v2 migration.
- Creator creates a pool per stream; viewers swap.
- Devnet only. No real money in week 1.

## Open questions for the team
- steve: scope + order OK? Anything to cut?
- art_design: look of the web app + overlay (A/B/C pictures for Boss man).
- tester: test plan for devnet launch/buy/sell/graduate.
