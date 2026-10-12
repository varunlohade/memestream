# memestream: submission pack

**Deadline:** 2026-10-13 06:59 UTC (12:29 IST). **Target:** submit tonight, 2026-10-12.
Meteora DBC listing: https://superteam.fun/earn/listing/meteora-dbc

## Where we submit

| Target | Where | Notes |
|---|---|---|
| Colosseum, Solana track | colosseum.com | Main project entry |
| Meteora DBC bounty | _[Colosseum link for the Meteora bounty]_ and https://superteam.fun/earn/listing/meteora-dbc | Judges favour DBC at the centre, mainnet, real users, open source |
| Superteam India | _[Superteam India link]_ | Check the form fields on the day |

## Checklist

- [x] Live on devnet: coins, graduation, LP claims, predictions and prediction markets
      (https://memestream-iota.vercel.app)
- [x] Mainnet preset proven on Meteora's real programs (`test/integration/mainnet-config.surfpool.ts`)
- [ ] Mainnet live. Fallback in use: submit on devnet. Mainnet blockers are in MAINNET-CHECKLIST.md.
- [ ] 1+ real outside stream with a live coin, real trades and a fee claim: _[done / not done]_
- [x] Demo clips recorded (`demo/flows/01` to `10`); a markets clip is still _[to record]_
- [ ] 2-min demo video cut and uploaded (YouTube unlisted or Loom); link in README and the forms
- [ ] Pitch deck link in README and the forms
- [x] README traction numbers refreshed from devnet (see Traction below)
- [ ] Repo: give `dannxbt` read access, or make it public (run the secret scan first)
- [ ] Forms sent (Boss man presses submit himself)

## Steps only Boss man can do

1. Register every team member on colosseum.com and add them to the project.
2. Decide repo visibility: public, or private with read access for the judges (`dannxbt` for Meteora).
3. Record the missing clips, cut the 2-min video and upload it. Paste the link into README and the forms.
4. Fill the form fields in your own words (outline below), then press submit on each target.

## Traction

Devnet, as of [date time IST]; mostly our own testing: [N] coins launched on our config, [N] trades,
[N] SOL volume, [N] graduations to DAMM v2, [N] SOL in creator fees claimed, [N] prediction markets
created. Without coins from our two test wallets: [N] coins, [N] trades, [N] SOL volume,
[N] graduations.

How we counted: a read-only script lists every DBC pool on our config, reads each pool's and each
graduated DAMM v2 pool's transactions, and counts swaps and creator fee claims. Markets count the
oracle's transactions to the MetaDAO vault program.

## How it uses DBC

- One shared DBC config for every coin: 1B supply, an anti-sniper fee scheduler (50% to 1% in 60 s)
  plus a dynamic fee, 80% of trading fees to the creator, a launch fee to the partner, and 100% of
  graduated liquidity locked forever (all of it the streamer's on mainnet).
- `swap2` partial fill, so the last buy fills exactly to the threshold.
- Creator fee claims for the streamer, any time.
- Permissionless graduation (DBC to DAMM v2 migration), pressed by anyone from the app, live on stream.
- After graduation: DAMM v2 swaps inside memestream and LP position-fee claims for the streamer.
- DAMM v2 again for prediction markets: each question's YES and NO tokens trade in one pool.
- An OBS overlay and `/TICKER` short links, so graduation happens live on stream; Solscan links on
  every trade.

## Predictions (free points)

- Every wallet gets 1,000 points on its first sign-in (at most 5 wallets per IP a day). Points can't
  be bought, sold or sent.
- Holders suggest yes/no questions. jev (TypeSafe's model) reviews each one on the server in about a
  second. Spam and unsafe questions never show to others.
- Upvotes launch a question by themselves. Up to 10 run at once per coin.
- The streamer resolves. An AI check reads stream frames, describes them with a vision model, and
  asks jev what happened. It is a second opinion and never changes payouts by itself.
- Bettors can flag a result; enough flags mark it disputed.

## Prediction markets (devnet SOL)

- Polymarket-style YES/NO markets on each live question.
- Each market is a MetaDAO conditional vault plus ONE Meteora DAMM v2 YES/NO pool.
- Buys and sells use split-and-swap routing with Gnosis FPMM maths, so there is no bet cap.
- A 0.3% pool fee.
- The streamer's result is a proposal for 2 hours. A holder can challenge it with a 100-point bond.
  An admin upholds, overturns or voids. With no decision in 24 hours, the market voids as a last resort.
- Streamers and mods can't bet on, challenge or judge their own coin's markets.
- Several security audits, with the findings fixed. Markets stay off on mainnet until the blockers
  in MAINNET-CHECKLIST.md are done.

## Trust and edge cases

- **Who resolves:** the streamer, who sees the stream. For points, the AI check gives a second
  opinion and bettors can flag. For markets, the result is only a proposal until the challenge
  window ends.
- **Challenge window:** 2 hours. Any holder can challenge with a 100-point bond and a reason. An
  admin who isn't the streamer decides.
- **Streamer can't bet:** streamers and mods can't bet on, challenge or judge their own coin. A
  streamer's wallet can't buy their own coin either.
- **Stream ends:** a question nobody resolves cancels by itself and refunds every bet (15 minutes
  for crowd questions, 60 minutes otherwise). A market nobody resolves waits for an admin, then voids.
- **Ambiguous result:** the streamer or admin picks Cancel or Void, and every bet comes back.
- **On-chain trades are real:** every coin trade, graduation, claim and market bet is a real Solana
  transaction, with a Solscan link in the app.

## Safety: what we learned from pump.fun live

- pump.fun paused its livestreams in November 2024 after streamers used them for harmful stunts to
  pump their coins.
- memestream doesn't host video. The stream stays on Twitch or YouTube, under their moderation and
  rules; we only embed it.
- jev reviews every typed question before anyone else sees it, so a question can't ask for harm.
- Streamers can't bet on or judge their own questions, so they have less reason to stage outcomes.

## Why not just pump.fun live?

pump.fun live proves people want a coin for a stream. memestream brings that to streamers where they
already are (Twitch and YouTube), through an OBS overlay, with better terms:
- 80% of every trade fee goes to the streamer.
- On mainnet, the whole graduated LP is locked to the streamer, so they earn pool fees forever.
- A launch fee that falls from 50% to 1% in a minute, so snipers don't win.
- A graduation anyone can trigger live on stream.
- Predictions on every stream: free points for everyone, and real YES/NO markets.
- All on Meteora.

## Built with care

- Money safety: a trade never fills worse than the quote, and slippage comes only from a whitelist.
- Tests on Meteora's real programs, on an offline local chain.
- Security audits of coins, predictions and markets; every critical, high and medium finding fixed.
- Repeatable end-to-end runs on devnet for predictions (`npm run e2e:predictions:local`) and markets
  (`scripts/markets-e2e.mts`).
- AI keys stay on the server; `npm run check` scans the browser bundle for them.

## Demo video: 2 minutes

Clips live in `demo/flows/`.

| Time | Clip | Shot | Voice-over idea |
|---|---|---|---|
| 0:00-0:10 | `01-home.mp4` | The pump.fun-style home: king of the hill, coin grid | Every live stream gets its own coin. |
| 0:10-0:25 | `02-golive.mp4` | Paste a stream link, ticker, Launch, wallet approves | One transaction on Meteora's DBC. |
| 0:25-0:35 | `03-coinpage.mp4` | Coin page: big stream, chart, curve progress, holders | Watch and trade in one place. |
| 0:35-0:50 | `04-buy.mp4` | Trade box in the first minute: the launch fee counting down; a buy | The fee falls from 50% to 1%, so snipers don't win. |
| 0:50-0:58 | `05-sell.mp4` | A sell, with the Solscan link | Every trade is on chain. |
| 0:58-1:08 | `06-claim.mp4` | Streamer claims earnings | 80% of every fee goes to the streamer. |
| 1:08-1:20 | `07-graduate.mp4` | The curve fills; Graduate to Meteora; overlay flips | Anyone graduates the coin live, into DAMM v2. |
| 1:20-1:30 | `08-pool.mp4` | A trade on the graduated pool; Claim pool fees | Trading goes on; the streamer's LP earns fees. |
| 1:30-1:40 | `09-predictions-points.mp4` | First sign-in: 1,000 points; suggest a question; under review | Free points; AI reviews each question. |
| 1:40-1:50 | `10-predictions-live.mp4` | A live question, bets, the streamer resolves | The crowd bets on what happens next. |
| 1:50-2:00 | _[markets clip, to record]_ | Market card: buy YES in SOL, the challenge window | Real YES/NO markets on Meteora pools. |

Recording tips: 1920×1080, browser zoom 100%, a muted stream, no wallet addresses or balances you'd
rather not show.

## Form fields: outlines only

Write these answers yourself. Judges read them as the team's own words. Each outline lists the
questions to answer and the facts to include.

**Project name and one-line tagline**
- Name: memestream. Tagline idea: "a prediction market for every live stream".

**Short description (2-3 sentences)**
- What does a streamer do? What does a viewer do?
- Facts: a coin per stream on Meteora DBC; 80% of fees to the streamer; graduation to DAMM v2;
  free-points predictions and SOL markets on each stream.

**Problem**
- Why do streamers need a new way to earn? Why are viewers passive today?
- What went wrong with pump.fun live (the Nov 2024 pause)?

**Solution / how it works**
- The coin life: launch, trade, claim, graduate, pool fees.
- Predictions and markets: who asks, who reviews, who resolves, the challenge window.

**How it uses Meteora DBC** (Meteora bounty)
- Use the "How it uses DBC" list above: the config, fee scheduler, `swap2`, creator claims,
  permissionless graduation, DAMM v2 after graduation, DAMM v2 for markets.
- Point to the table in README.md.

**Traction**
- Paste the numbers from the Traction section, with the "devnet, mostly our own testing" label.
- Any outside streamer or user feedback? _[yes / no, who]_

**Business model**
- 20% of curve fees and a 0.05 SOL launch fee on mainnet. Who earns the 0.3% market pool fee? (Check before you write it.) Who pays what?

**What's next / mainnet plan**
- The open items in MAINNET-CHECKLIST.md; which come first; what a first streamer pilot looks like.

**Team**
- Who built what. Links (X, GitHub). Based in India (for Superteam India).

**Links**
- App https://memestream-iota.vercel.app · video _[link]_ · deck _[link]_ · repo _[link]_
