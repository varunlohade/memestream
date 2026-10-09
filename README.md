# memestream

A coin for every live stream. Viewers buy the stream they think will pop; the streamer earns
80% of every trade fee. When a coin's curve fills, it graduates into a Meteora DAMM v2 pool.

Built on **Meteora's Dynamic Bonding Curve (DBC)** for the Superteam "Best use of Meteora DBC" track.

## How it uses Meteora DBC

- **One shared config** (`src/lib/dbc/preset.ts`) defines every stream coin:
  1B supply priced in SOL, an anti-sniper fee that falls from 50% to a 1% base over the first
  minute (plus a small volatility fee during wild swings),
  80% of trading fees to the creator (the streamer), and 100% of graduated liquidity locked forever.
  On mainnet all of that locked liquidity goes to the streamer: after graduation, 100% of the pool's
  fees go to them, via an LP position NFT they claim in the app. (Devnet's existing config splits
  it 50/50 with the platform.)
  Graduation threshold: 0.1 SOL on devnet (so testers graduate with faucet SOL), 10 SOL on mainnet.
  Launching is free on devnet and costs 0.05 SOL on mainnet (paid to the partner).
- **Launch** (`launch.ts`): a streamer creates a pool on that config in one transaction. The
  stream link rides in the token's metadata URI, so no database is needed.
- **Trade** (`trade.ts`): partial-fill swaps, so the last buy before graduation fills exactly up
  to the threshold and the rest stays in the buyer's wallet.
- **Earn** (`fees.ts`): the streamer claims their SOL fee share at any time.
- **Graduate** (`graduate.ts`): once the curve holds the threshold, anyone can migrate the coin
  to a DAMM v2 pool. We call it ourselves instead of waiting for a migrator service.

Short links: `/<ticker>` redirects to the coin (the OBS overlay shows it). The first coin with a
ticker keeps its link; the server refuses a taken ticker at launch.

App rule (memestream's server and UI, not on-chain): a streamer's own wallet can't buy their coin
here. DBC swaps are open to anyone, so another wallet still can; the streamer's trades are tagged
in the trade list.

## Run it locally

Needs Node 20+. No faucet, no wallet extension. The first `dev:chain` run downloads Meteora's
programs from devnet into `.cache/`; after that it runs fully offline.

```bash
npm install
npm run dev:chain   # local offline chain with Meteora's real programs (copied from devnet once); seeds coins
npm run dev         # in a second terminal; open http://127.0.0.1:3000 (exactly this address)
```

Connect with **"Test wallet (localhost)"**. It only exists in local development, answers only
this app's own page, and signs only transactions this server built.

## Tests

```bash
npm run check            # everything fast: types, lint, unit tests, coin lifecycle on Meteora's real programs (~3 s)
npm run test:clock       # slow (~2.5 min): real-time clock; launch fee settles to 1%, blockhashes really expire
npx tsx scripts/e2e.mts  # clicks through the running app like a user (needs a fresh dev:chain + dev)
npx tsx scripts/mid-trade.mts  # reload / second tab / triple click mid-trade; run dev with
                               # MEMESTREAM_DEV_SEND_DELAY_MS=20000 so trades stay open
```

Money safety: from the moment the wallet prompt opens until the outcome is known, a pending
record (per wallet, in localStorage) locks every money action. If the outcome is uncertain, the
app asks you to check your wallet history and offers "I checked, unlock". Rules (a state table) and tests:
`src/lib/tx-flow.ts`.

## Known limits

- A wallet popup left open past the unlock window can still be signed after you unlock. Our
  transactions can't land once their blockhash expires, so this only affects wallets that swap in
  a fresh one; the app tells you to reject any open popup first.

The local chain runs offline with a real-time clock (a block every 400 ms), so the launch fee
falls to its 1% base about a minute after launch, as on mainnet.

## Layout

- `src/lib/dbc/`: on-chain logic (the only code that touches the Meteora SDK).
- `src/server/`: reads coins and builds transactions. The server never holds user keys.
- `src/app/api/`: JSON routes the browser calls.
- `src/components/`: the UI; it never builds transactions, the wallet signs what the server returns.
- `design/`: design spec, mocks and screenshots.
