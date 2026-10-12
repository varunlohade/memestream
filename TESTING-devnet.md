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
