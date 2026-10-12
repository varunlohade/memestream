# memestream: devnet test list for Boss man

Site: https://memestream-iota.vercel.app (devnet, test money only)
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

## 3. Buy and sell (Viewer, after the first minute)
- [ ] The fee line is gone. Buy 0.02 SOL.
- [ ] Phantom asks once. Approve. You see "Bought <TICKER>" and your holdings go up.
- [ ] While a trade runs, click Buy again: nothing happens. Reload the page: it still waits, then says it went through. (No double charge.)
- [ ] Sell tab → 50% → Sell. You see "Sold <TICKER>" and SOL comes back (minus about 1% fee each way).

## 4. Graduate (Viewer)
- [ ] Buy until the XP bar reaches 0.1 / 0.1 SOL (one 0.15 buy fills it; the extra stays in your wallet).
- [ ] The page says "The curve is full." Press "Graduate to Meteora". Approve.
- [ ] You see "Graduated to Meteora", the XP bar says "Graduated", and the page says "Graduated: trades in its Meteora pool."

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
- [ ] Open /overlay/<your coin address>?layout=a (also try b and c): see-through panel with price and XP bar; shows "Graduated" after step 4.
- [ ] Optional: add that URL in OBS as a Browser Source (1920×1080).

## 8. Quick break tests
- [ ] Reject a trade in Phantom: the page unlocks right away, nothing spent.
- [ ] Open the coin in 2 tabs, buy in one: the other says a trade is in progress.
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
