# memestream: week 2 plan (draft, 2026-10-08)

Status: IN PROGRESS. Repo pushed (private: github.com/varunlohade/memestream). Overlay steps 1-2 done.

## Decisions (2026-10-08)
- **Platforms: YouTube Live and Twitch.** Go live requires one of them (client and server). No Kick.
  Coin tiles and the coin icon show the stream's real picture; the coin page plays the stream (muted).
- **Overlay layout: A, corner panel.** It covers the least gameplay; game HUDs often sit bottom center (C).
- **Wordmark: 1, lowercase VT323.** It's already in the app.
- **Hosting: Vercel**, on the free *.vercel.app URL for now. Buy memestream.lol later.
  Devnet first; mainnet waits on the checklist.
- **Mainnet graduation: proposed 50 SOL** (see MAINNET-CHECKLIST.md). Needs Boss man's final yes before the config.
Goal of week 2: streamers show their coin live on stream, and memestream runs on mainnet by Oct 20.

## 1. OBS overlay (the main week 2 feature)

What it is: a page a streamer adds to OBS as a **Browser Source**. It shows their coin's price,
change and XP graduation bar on top of the stream, and flips to "Graduated" when the coin graduates.

Look: style B ("Deepslate night"), one of these layouts (`design/boards/MS-overlay.png`):
- **A, corner panel** (bottom left): ticker, market cap, change, link, XP bar "to graduation".
- **B, top strip** (full width): everything in one line. Takes the least height.
- **C, hotbar** (bottom center): an XP bar over a row of hotbar slots. The most "game-like".
Each one has a "Graduated" state. art_design's mock: `design/mock/mc.html?opt=B&screen=overlay&v=A|B|C&phase=live|grad`.

### Build steps (small steps, each with a blind review)
1. **Route** `/overlay/[mint]`: transparent page background, no top bar, no wallet, no texture
   behind the panel. Server-renders the coin (404 if not a memestream coin).
2. **Live data**: poll `/api/coins/[mint]` every 5 s (no wallet, so a read-only view). Hold the
   last good value through errors; never flash empty. Pause when OBS hides the source.
3. **Picked layout** from the B mock, at 1920×1080. Text has black strokes so it reads on busy games.
4. **"Graduated" state** when status is graduated (the bar shows "Graduated", the text "Now trading on Meteora").
5. **Link line**: `memestream.lol/<ticker>`, as soon as the domain is decided.
   Needs a short-link route `/[ticker]` that redirects to `/coin/<mint>` (tickers may clash: pick the newest live coin).
6. **"Add to OBS" helper** on the coin page, shown to the streamer only: copy the overlay URL,
   plus 3 steps (Sources, +, Browser, paste URL, 1920×1080). A screenshot in the help.
7. **Tests**: a server test that the overlay renders for a coin and 404s otherwise; a headless
   screenshot of each state (trading, graduated) for the PR; e2e: open the overlay for a seeded coin.

### Constraints
- Keep it read-only: no wallet code and no transactions on the overlay page.
- Performance: one poll per 5 s per overlay. Serve the coin JSON with a short cache so 1000 viewers'
  overlays (if a streamer shares the URL) cost the same RPC as one.
- No "Minecraft" anywhere, and no Mojang assets (spec rule).

## 2. Mainnet readiness (with Boss man's go only)
Follow `MAINNET-CHECKLIST.md`. Blockers that need Boss man:
- **Hosting** (Vercel or other, and who pays). The domain, `MEMESTREAM_PUBLIC_URL`, the shared rate
  limiter (e.g. Upstash on Vercel) and the trusted client-IP header all depend on it.
- Graduation threshold (placeholder 85 SOL); config params are fixed once created.
- His real partner wallet for `feeClaimer` and `leftoverReceiver`.
- Domain (`memestream.lol`) and `MEMESTREAM_PUBLIC_URL`; on-chain metadata URIs never change.
- One full pass on real devnet first (needs faucet SOL for 6wVWwYoF4gEP5mVMcTLYAhgNpvXpYTWcY8hdfi68m4o5).
- Paid RPC; shared rate limiter keyed on the platform's real client IP.

## 3. Real users (start now: they weigh most with judges)

### Platform rules first (checked 2026-10-08; official text where marked)
1. **Kick: banned in ads (official).** Its Advertising Policy prohibits promoting "meme-coins", token
   offerings (ICOs/IDOs, token liquidity pools) and trading advice, and "ad" includes branded
   integrations. A streamer pushing their coin on Kick risks a strike. https://kick.com/advertising-policy
2. **Twitch: not banned for your own coin, but a grey area (official).** Branded content (anything paid
   by someone else) may not promote "Certain financial products and services, such as Initial Coin
   Offerings (ICOs), multilevel marketing and get rich quick schemes". Own products are separate:
   "You do not need to use the branded content disclosure tool when promoting your own products and
   services", though legal disclosure duties remain. The Community Guidelines don't mention crypto.
   They ban illegal activity, scams, spam and listed gambling sites. Risk: a moderator reads a coin
   launch as an ICO. https://help.twitch.tv/s/article/branded-content-policy
3. **YouTube Live: allowed with disclosure (news reports of the Nov 2025 update; the official page
   wasn't fetched).** The update targets *gambling* with digital assets (skins, NFTs used for
   wagering), not general crypto content. Paid promotion needs YouTube's disclosure toggle.
   Its live embed is reliable, and our app already supports it.
4. **X Live: allowed, but a weak embed.** X allows crypto posts with paid-promotion disclosure. Its
   official widget is unreliable for live broadcasts, and often renders blank for logged-out
   visitors, so on our coin page it would usually be a "Watch on X" link, not a player.
5. **Pump.fun Live: unclear and a competitor (official terms, updated 25 Sep 2026).** No rule bans
   promoting an outside token, but Pump can terminate for "off-platform conduct connected to Digital
   Asset activity" and other integrity concerns "in Pump's sole opinion", and it runs its own
   streamer coins. Don't build on it. https://pump.fun/docs/terms-and-conditions

**Recommendation (Boss man decides):** lead with **YouTube Live**: allowed, embeds reliably, already
supported. **X Live** comes second, as a link out. Avoid Kick. Twitch only with the streamer's own coin
and an on-stream "my coin" disclosure, accepting the grey-area risk. Always: no price promises or
trading advice, from us or the streamer.

### Candidate streamers (research only; nothing sent)
Source: TwitchMetrics, "Most Watched Crypto Twitch Streamers, October 2026" (hours watched this
month, not average viewers, which isn't published), plus blocmates (June 2025) where noted.
They stream crypto on Twitch today, so per the rules above we'd invite them to do a memestream
stream on **YouTube Live** (or X Live). Smaller channels first: they're likelier to say yes.
Contact: through the links on each streamer's own Twitch profile (usually X). No emails collected.

| # | Handle (Twitch) | Hours watched, Oct 2026 | Notes |
|---|---|---|---|
| 1 | bofomosol | 19,576 | Solana memecoin streams |
| 2 | solanaswaggy | 32,738 | Solana-focused name |
| 3 | SolanaDalii | 31,963 | Solana-focused name |
| 4 | FlamesOnSol | 36,026 | Solana-focused name |
| 5 | otuveq | 31,710 | |
| 6 | Heyitsyolo | 32,871 | |
| 7 | darellcrypto | 35,774 | |
| 8 | KingtreyTV | 31,803 | |
| 9 | daumenxyz | 46,878 | |
| 10 | alxcooks | 66,814 | |
| 11 | contractreader | 22,447 | |
| 12 | mirgilzz | 21,624 | |
| 13 | MinhArte | 19,474 | |
| 14 | jackduvaltrades | 17,444 | |
| 15 | Bee_Empire | 16,823 | |
| 16 | Zrool | 15,450 | |
| 17 | FASHR | not in Oct top 40 | memecoins on Axiom/Nova; ~308 avg viewers (blocmates, 2025) |
| 18 | kryptokinglive | not in Oct top 40 | 24/7 Solana memecoin trading (blocmates, 2025) |
| 19 | cented | 124,960 | bigger; stretch goal |
| 20 | dvces | 398,241 | biggest crypto channel; stretch goal |

Before contacting: open each profile, check they're active this month, note their X handle, and
skip anyone who streams casino/gambling content.

### DM draft (Boss man sends it himself)
> Hey {name}, I'm building memestream: a coin for a single live stream, on Solana. Viewers buy if
> they think the stream will pop, and 80% of every trade fee goes straight to you, claimable any
> time. When enough people buy, the coin graduates to a Meteora pool live on stream.
> We're looking for 3 to 5 streamers to try one stream with us in the next two weeks, on YouTube Live
> or X Live. It takes two minutes to launch, there's an OBS overlay with a progress bar, and
> you never have to buy your own coin (the app won't let you).
> No payment from us, no price promises. You'd just keep the fees your viewers' trades earn.
> Want a 2-minute demo link?

Tone notes: no hype words, no profit claims. It says plainly that we don't pay them and they keep
the fees.

## Competitors found during this research (2026-10-08)
- **StackLive** (stacklive.xyz): tokens for Twitch/Kick/pump.fun streamers on Solana, creator fees
  to a vault per channel, on pump.fun's curve. In preview: "program: not deployed", vaults simulated.
- **Feebits** (feebits.fun, "Coins that pay Twitch streamers") and **StreamPaid** (streampaid.xyz,
  "Fund Twitch streamers on-chain"): same space; details not checked.
- Our edge to stress in the demo: built on **Meteora DBC** (the bounty's point), graduation to DAMM v2
  live on stream, the streamer can't buy their own coin, and money-safe trading. None of them is a
  Meteora DBC entry.

## Order
1. Boss man: repo go → steve's pre-push audit → first push (private).
2. Overlay steps 1–4 (doesn't need mainnet).
3. Real devnet pass → mainnet config (Boss man's go) → deploy.
4. Overlay steps 5–7 once the domain is set.

## Open questions for Boss man
- Hosting: Vercel or other, and who pays?
- Platform: lead with YouTube Live (allowed, reliable embed), X Live as a link, avoid Kick, Twitch only with disclosure?
- Overlay layout: A, B or C?
- Wordmark: 1 (lowercase VT323) or 2 (Silkscreen caps)?
- Mainnet graduation threshold?
- Buy memestream.lol?
