# memestream: devnet test list for Boss man

Site: https://memestream-iota.vercel.app (devnet, test money only)
Test journeys with pictures (private): https://claude.ai/artifact/597JtzSejT5K5J3FVCvNjG
Graduation on devnet: 0.1 SOL. Launch fee on devnet: free.

## 0. Set up (5 min)
- [ ] In Phantom: Settings → Developer Settings → Testnet Mode on → Solana Devnet.
- [ ] Make 2 wallets in Phantom: **Streamer** and **Viewer**. (A streamer can't buy their own coin.)
- [ ] Get devnet SOL into both: ~0.3 SOL each. Use faucet.solana.com, or ask steve to send some from the test partner wallet.

## 1. Launch a coin (Streamer wallet)
- [ ] Open the site, connect the **Streamer** wallet.
- [ ] Go live: give a name, a ticker (capital letters/digits) and a YouTube or Twitch link.
- [ ] Phantom asks once. Approve. You land on the new coin's page.
- [ ] The coin page shows your stream picture or a muted player, and the "Unverified" tag.
- [ ] Try to buy your own coin: it stops before Phantom with "memestream won't let a streamer's wallet buy their own coin". (Selling is allowed.)

## 2. First minute (Viewer wallet, right after launch)
- [ ] Switch Phantom to **Viewer**, reload the coin page.
- [ ] The trade box shows "Launch fee now X%, drops to 1% in Ns", counting down.
- [ ] Type 0.01 SOL. "You get about" shows a number. (Don't buy yet unless you want to see the high fee.)
- [ ] Try the amount chips, the SOL/coin unit switch and max slippage (0.5, 1, 3 or 5%).

## 3. Buy and sell (Viewer, after the first minute)
- [ ] The fee line is gone. Buy 0.02 SOL.
- [ ] Phantom asks once. Approve. You see "Bought <TICKER>" and your holdings go up.
- [ ] The result shows a Solscan link. Open it: the trade is on devnet.
- [ ] Sell tab → 50% → Sell. You see "Sold <TICKER>" and SOL comes back (minus about 1% fee each way).

## 4. Graduate (Viewer)
- [ ] Buy until the curve progress reaches 0.1 SOL (one 0.15 buy fills it; the extra stays in your wallet).
- [ ] The page says "The curve is full." Press "Graduate to Meteora". Approve.
- [ ] The coin shows as graduated and now trades in its Meteora pool.

## 5. After graduation (Viewer)
- [ ] Buy 0.01 SOL again: it trades in the Meteora pool.
- [ ] Sell some back.

## 6. Streamer earnings (Streamer wallet)
- [ ] Switch to **Streamer**, open your coin.
- [ ] "Claim earnings" shows SOL from the curve trades. Claim it; SOL arrives.
- [ ] Under "Your LP NFT: pool fees", "Claim pool fees" shows fees from the graduated pool trades. Claim it; SOL arrives.
- [ ] With the **Viewer** wallet, the claim buttons don't appear.

## 7. Overlay and short link
- [ ] Open https://memestream-iota.vercel.app/YOURTICKER: it goes to your coin.
- [ ] Open /overlay/<your coin address>?layout=a (also try b and c): see-through panel with price and graduation bar; shows "Graduated" after step 4.
- [ ] Optional: add that URL in OBS as a Browser Source (1920×1080).

## 8. Quick break tests
- [ ] Reject a trade in Phantom: nothing is spent, and you can trade again at once.
- [ ] Open /coin/ with a random address: you get "Not found".

If anything looks wrong, note the step number and what you saw, and send it to steve.

## 9. Test predictions (free points, no money)

### a. Automated: one command
```bash
vercel env pull .env.e2e.local --environment=development   # once: the Upstash URL and token (git-ignored; never commit or share it)
npm run e2e:predictions:local
```
- It builds the app, starts it on a free local port against devnet, and plays a full round through the real routes and the real Upstash Redis.
- Every run uses its own Redis key prefix (`memestream:pm-e2e:<run id>:`) and deletes only those keys at the end.
- Every run launches a fresh coin. 4 viewer wallets live in `.keys/e2e-viewer-N.json` and get about 0.05 devnet SOL each from `.keys/partner.json`.
- It prints one PASS or FAIL line per step and exits non-zero on any failure. One run takes about 6 to 8 minutes (the build, then the bet windows; public devnet RPC limits slow some calls). There is no watch-time wait: the first sign-in grants the points.
- If you stop a run early, delete its keys: `E2E_CLEANUP_ONLY=1 MEMESTREAM_PREDICTIONS_PREFIX=<its prefix> npx tsx scripts/predictions-e2e.mts` (with the Upstash env loaded).
- The first sign-in of a wallet grants 1,000 points at once, for at most 5 wallets per IP a day; the run checks that a 6th wallet gets none.
- Against a server you started yourself: `BASE_URL=... MEMESTREAM_PREDICTIONS_PREFIX=memestream:pm-e2e:<id>: KV_REST_API_URL=... KV_REST_API_TOKEN=... npx tsx scripts/predictions-e2e.mts`. The server must use the same prefix.

### b. By hand on the live site (2 wallets)
- [ ] **Streamer** wallet: open your coin page and sign in to predictions (one signature, no SOL).
- [ ] **Viewer** wallet (holds at least 1 of the coin): open the same coin in another browser and sign in.
- [ ] The viewer's first sign-in shows "Your points: 1,000" at once. Holders can suggest and upvote right away.
- [ ] Keep the streamer's page open: it marks the streamer "here", which the crowd's questions need.
- [ ] Streamer: type a question and launch it at once. Pick the 1-minute window. You don't need a viewer's suggestion.
- [ ] Viewer: bet on YES or NO (at most half your points).
- [ ] Streamer: try to bet. It says streamers can't bet on their own coin.
- [ ] After the minute, the streamer resolves. The viewer's points go up on a win, or the stake is gone on a loss.
- [ ] Viewer: flag the result. It shows as flagged.
- [ ] Launch a second question and resolve it as Cancel. The viewer gets the stake back.

## 10. Test prediction markets (devnet SOL)

Needs `MEMESTREAM_MARKETS=1` on the server and an admin wallet in `MEMESTREAM_ADMIN_WALLETS`.

### a. Automated
- `scripts/markets-e2e.mts` plays one full round against a running server: launch a question, the
  market opens, a viewer buys YES and sells half back, trading closes at the lock, the streamer
  proposes YES, a holder challenges with a bond, an admin decides, the viewer redeems. The file's
  header lists the env it needs. Run the server with `MEMESTREAM_MARKET_CHALLENGE_MIN=3` (test runs
  only) so the challenge window is short.

### b. By hand on the live site (3 wallets: Streamer, Viewer, Admin)
- [ ] **Streamer:** launch a question (as in 9b). The question shows a market card with YES and NO odds.
- [ ] **Viewer:** buy YES with 0.01 devnet SOL. Phantom asks once. Your position line shows YES shares.
- [ ] **Viewer:** buy a bigger amount: it still fills (no bet cap); the odds move.
- [ ] **Viewer:** sell some shares back. SOL returns, minus the 0.3% pool fee and price moves.
- [ ] **Streamer:** try to buy: it says you can't bet on your own coin.
- [ ] After the lock, trading closes. **Streamer:** resolve YES. The card shows "Proposed: YES" and a
      2-hour countdown.
- [ ] **Viewer:** press Challenge, give a reason (and a link if you have one). It costs 100 points.
- [ ] **Streamer:** the Challenge button doesn't appear for your own coin.
- [ ] **Admin:** open the coin. Pick Final YES, Final NO or Void.
- [ ] **Viewer:** press Redeem. A winning share pays 1 SOL; a void pays 0.5 SOL per share.
- [ ] Every market trade shows a Solscan link.

## D. Prediction markets: exact steps (live site, devnet)

Browser 1 = **Streamer** (the wallet that launched the coin). Browser 2 = **Viewer** (`BxfZ…6Enf`, also
the admin). For the fast path to Redeem you need a third wallet, **Viewer 2** (any new Phantom account):
the admin can't decide a challenge it made itself. Ask Claude for devnet SOL for it.

Both browsers: open the coin page → **predictions** tab → **Sign in to play** → approve the message.
You see "Your points: 1,000". A viewer must hold at least 1 of the coin to suggest or upvote.

### D1. Streamer asks

1. Streamer: type in **Ask your own yes/no question**.
2. Streamer (optional): paste a link in **Official source link for a real-world question (optional)**.
3. Streamer: pick **Window** 1, 2, 5 or 10 minutes (use 1 for a quick demo).
4. Streamer: press **Launch**. It shows **Under review** for about a second (jev).
5. Both: the card shows **Opening market…** for about 20 s, then **Live · closes in M:SS**.

### D2. Viewer asks

1. Viewer: type in **Suggest a yes/no question**.
2. Viewer: press **Suggest, 10 points**. Your points drop by 10.
3. Viewer: your question shows **Under review** (only you see it), then appears in **Up next** for everyone.
   Junk is refused with "Not approved: …"; the 10 points stay spent and you wait 5 minutes.
4. Others (holders, not you, not the streamer): press **Upvote**. It changes to **Upvoted**.
5. Crowd pick: at 3 upvotes it goes live by itself, but only while the streamer has the page open
   and crowd picks are on.
6. Or the Streamer presses **Launch** on it in **Up next** (or **Remove** to drop it).
7. When it goes live, the asker gets the 10 points back.
8. Not picked within 20 minutes: it expires and the 10 points stay spent.

### D3. Trade, close, resolve, redeem

1. Viewer: press **BUY YES · 50%** (or **BUY NO · 50%**). A box opens with **Buy** / **Sell** tabs.
2. Viewer: pick **0.01**, **0.05**, **0.1** or **max**; check **You get ≈ N YES shares**; press **Confirm**; approve in Phantom.
3. Both: the YES/NO bar and the % move. The viewer sees "Your position: N YES shares · pays N SOL if Yes".
4. Viewer: **Sell** tab → amount → **Confirm** to sell some back for SOL.
5. Streamer: trying to buy is refused (streamers can't bet on their own coin).
6. When the window ends: the card says **Betting closed** and the buttons go away.
7. Streamer: press **Resolve Yes** (or **Resolve No**, or **Cancel** for a refund proposal).
8. Both: the card shows **Proposed: YES · final in 1:59:xx** and **Resolves from: …**. After a few
   seconds an **AI check** tag may appear.
9. Normal path: wait 2 hours, then it shows **Final: YES**. There is no shortcut on the live site.
10. Fast path, for the demo:
    - Viewer 2 (holds a share): press **Challenge** → type in **Why is the result wrong?** → **Challenge, 100 points**.
    - The card shows **Disputed: under review** and "A holder challenged it".
    - Viewer (admin `BxfZ…`): press **Final YES** (or **Final NO**, or **Void** for a 50/50 refund).
11. Both: the card shows **Final: YES**.
12. Winner: the card shows **You won N SOL**. Press **Redeem #N** → approve. It turns to **Redeemed**; each winning share paid 1 SOL.
    On **Void**, every share pays 0.5 SOL.

#### Payouts

- Before you buy: in the buy box, under **You get ≈ N YES shares**, check
  **If YES wins, you get ≈ N SOL (+X%)**. Each winning share pays 1 SOL, so N SOL = N shares and
  X% = (shares − SOL in) ÷ SOL in. The Sell tab doesn't show this line.
- After the final result, the card shows one line:
  - Winner: **You won N SOL** and a **Redeem #N** button.
  - Loser: **Your NO shares pay 0. YES won.** (or **Your YES shares pay 0. NO won.**). No button.
  - Void: **Refund: N SOL (0.5 per share)** and **Redeem #N**.
  - No shares: **You held no shares**.
- While betting is open, the card shows one muted line: **Fee 0.3% per trade: 80% to the market's
  starting liquidity (memestream), 20% to Meteora. The streamer earns on the coin, not on markets.**
  The pool's own fee settings say this: a flat 0.3% to the liquidity provider (the oracle's position,
  seeded by memestream), and Meteora's protocol keeps 20% of it.

**Worked example (round 5 on devnet, read from the chain).** Viewer A (`2WVQ…uq74`) bet on YES, and
YES won. Nobody bought NO, so the other side was the pool's starting liquidity: memestream's
0.05 SOL seed, as 0.05 YES and 0.05 NO.

| Step | Transaction | SOL | YES shares |
|---|---|---|---|
| Buy YES | `4sZi…FYPw` | 0.005 in | +0.009544883 |
| Sell half | `yws7…H1CP` | 0.002535623 back | −0.004772442 |
| Redeem | `5yo2…goNV` | 0.004772441 back | −0.004772441 |

A put in 0.005 SOL, sold half for 0.002535623 SOL, and redeemed 0.004772441 SOL. That is
0.007308064 SOL back, a profit of 0.002308064 SOL (+46%). At the buy, the box would have shown
"If YES wins, you get ≈ 0.00954 SOL (+91%)". Each transaction also cost a 0.000005 SOL network fee.
The buy paid 0.00297688 SOL rent for two token accounts, and the redeem returned it.
