# memestream: submission pack

**Deadline:** 2026-10-13 06:59 UTC (12:29 IST). **Target:** submit by 2026-10-12 ~20:00 IST (16 h buffer).
Listing: https://superteam.fun/earn/listing/meteora-dbc

## Checklist
- [ ] Mainnet live (fallback: devnet + the mainnet preset proven on the real programs)
- [ ] 1+ real stream with a live coin, real trades, a fee claim (graduation is a bonus)
- [ ] 2-min demo video uploaded (YouTube unlisted or Loom), link in README and the form
- [ ] README numbers filled in (coins, trades, volume, graduations, streamer earnings)
- [ ] Repo: give `dannxbt` read access, or make it public (run the secret scan first)
- [ ] Submission form sent (Boss man presses submit himself)

## Fallbacks (so we never end with nothing)
- Mainnet inputs not in by **Oct 11 noon IST** → submit on devnet, with the full video and the
  mainnet preset proven on Meteora's real programs (`test/integration/mainnet-config.surfpool.ts`).
- No outside streamer says yes by **Oct 11** → Boss man or a friend runs one short live stream so
  the demo has a real coin, real trades and a fee claim. Plan the demo around trades and a claim;
  a graduation is a bonus (it needs the threshold filled).

## Demo video: 2 minutes

| Time | Shot | Voice-over (short, plain) |
|---|---|---|
| 0:00-0:10 | A live stream with the OBS overlay: coin, price, the graduation bar moving | "Every live stream gets its own coin. Viewers buy the stream they think will pop." |
| 0:10-0:30 | Go live: paste a YouTube link, ticker, Launch, wallet approves, land on the coin page | "A streamer launches in one transaction on Meteora's Dynamic Bonding Curve." |
| 0:30-0:45 | Trade box in the first minute: "Launch fee now 46%, drops to 1% in 52s" | "A launch fee falls from 50% to 1% in a minute, so snipers don't win." |
| 0:45-1:05 | A viewer buys; the ticker tape and the overlay update; Recent trades | "Viewers trade on the curve. 80% of every fee goes to the streamer." |
| 1:05-1:15 | Streamer clicks Claim earnings; SOL arrives | "The streamer claims their earnings any time." |
| 1:15-1:35 | The curve fills: "This fills the curve", Graduate to Meteora, the GRADUATED tag; overlay flips | "When the curve fills, anyone graduates the coin live, into a Meteora DAMM v2 pool." |
| 1:35-1:50 | A trade on the graduated coin; "Your LP NFT: pool fees" → Claim pool fees | "Trading continues on memestream, and the streamer's locked LP keeps earning pool fees forever." |
| 1:50-2:00 | Explorer showing the config and a graduation tx; the URL | "All on Meteora, all on-chain. memestream." |

Recording tips: 1920×1080, browser zoom 100%, a muted stream behind the overlay, no wallet
addresses or balances you'd rather not show.

## Submission text (draft)

**Title:** memestream: a coin for every live stream, on Meteora DBC

**Short description:**
memestream gives every live stream its own coin. Streamers launch in one transaction on Meteora's
Dynamic Bonding Curve and earn 80% of every trade fee. Viewers buy the stream they think will pop.
When the curve fills, the coin graduates live on stream into a Meteora DAMM v2 pool, where trading
continues on memestream and the streamer's locked LP position earns the pool's fees forever.

**How it uses DBC:**
- One shared DBC config: 1B supply, an anti-sniper fee scheduler (50% → 1% in 60 s) plus a dynamic
  fee, 80% of trading fees to the creator, a launch fee to the partner, and 100% of graduated
  liquidity permanently locked (all of it the streamer's on mainnet).
- Partial-fill swaps (`swap2`), so the last buy fills exactly to the threshold.
- Creator fee claims, permissionless graduation (DBC → DAMM v2 migration) triggered from the app,
  then DAMM v2 swaps and LP position-fee claims after graduation.
- OBS overlay and short links so the graduation happens live on stream.

**Traction:** devnet, as of 11 Oct 2026, 13:27 IST: 7 coins launched on our config, 28 trades, 1.04 SOL volume, 5 graduations to DAMM v2, at least 0.0039 SOL in creator fees claimed. All from our own team testing so far.

**Links:** app https://memestream-iota.vercel.app · video _[link]_ · repo _[link]_

**Built with care:** money-safety (no double pays, never fills worse than the quote), three security
audits, tests on Meteora's real programs.
