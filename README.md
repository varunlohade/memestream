# memestream

**A coin for every live stream, built on Meteora's Dynamic Bonding Curve.**
Viewers buy the stream they think will pop. The streamer earns 80% of every trade fee. When the
coin's curve fills, it graduates live on stream into a Meteora DAMM v2 pool, where trading goes on
and the streamer's locked LP position earns pool fees forever.

- **Live app:** https://memestream-iota.vercel.app (devnet; mainnet addresses below once live)
- **Demo video:** _[2-min video link]_
- **Built for:** Superteam "Best use of Meteora's Dynamic Bonding Curve (DBC)"

## The whole coin life runs on Meteora

| Step | What happens | Meteora |
|---|---|---|
| Go live | A streamer pastes a YouTube/Twitch link and launches a coin in one transaction | DBC pool on our shared config |
| First minute | Anti-sniper fee falls from 50% to 1% (the trade box shows a live countdown) | DBC fee scheduler + dynamic fee |
| Trade | Buy and sell on the curve; the last buy fills only up to the threshold | DBC `swap2` partial fill |
| Earn | The streamer claims 80% of every trade fee, any time | DBC creator trading fee |
| Graduate | Anyone can migrate the full curve, live on stream | DBC → DAMM v2 migration |
| After graduation | Trading continues on memestream, in the coin's DAMM v2 pool | DAMM v2 swaps |
| Forever | The streamer's locked LP position NFT earns the pool's fees; claim in one click | DAMM v2 position fees |

### Fee flow

| Who | Before graduation | After graduation (mainnet) |
|---|---|---|
| Streamer | 80% of curve trading fees | 100% of the pool's LP fees (all graduated liquidity is theirs, locked forever) |
| Platform | 20% of curve trading fees + a 0.05 SOL launch fee | none |
| Liquidity | locked in the curve | 100% permanently locked in DAMM v2 |

Devnet's existing config uses a 0.1 SOL threshold (so testers graduate with faucet SOL), a free
launch and a 50/50 LP split; the mainnet preset (3 SOL threshold, 0.05 SOL launch fee, 100% LP to
the streamer) is proven on Meteora's real programs in `test/integration/mainnet-config.surfpool.ts`.

### Addresses

| | Devnet | Mainnet |
|---|---|---|
| memestream DBC config | `Buiw2JGkLJKgUcYPhsJ64L8x6xANqzHFxxnuc31mWyVg` | _[mainnet config]_ |
| DBC program | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | same |
| DAMM v2 program | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | same |

## What streamers and viewers get

- **Go live in two minutes:** paste a stream link, pick a ticker, launch. Coin pages play the stream.
- **OBS overlay:** price, change and the graduation bar on stream, plus a short link `/<TICKER>`.
- **Fair by default:** a streamer's wallet can't buy their own coin here; the first coin keeps its
  ticker; look-alike tickers are hidden; every coin shows "Unverified" until channels are verified.
- **Can't pay twice:** reloads, second tabs and fast double clicks still make exactly one trade.
- **Never fills worse than the price you saw:** a moved price makes the trade fail, not fill worse.
- **Live ticker tape** of trades and graduations.

## Proof it works

- **Real devnet, through the app's own server code:** launch, buy, sell, fill the curve, graduate to
  DAMM v2, buy and sell in the pool, and LP fee claims by both position holders. For example:
  graduate `37taDtwdmpxRi2WLtUmVG4LC11Bgsn7Apzu5WCgbAMMmGrhtMgofq3n3NvoZzWgFJgwBLAZfpr2b2Arn2HsLdkQy`,
  pool buy `4SsiqQ4G2KLwLKCdxjVcbyNLvvdW3NyKQivK8Wv2ewsBDFXcZTwvgXydp2CnMMhK9GYTYQSK73rGsnzM7hQ6ofSd`,
  streamer LP claim `ixVM6DbMHQqJpXaUY8WGosAQsQ3FufGea1yC9XWgEQ7w8zxAAXpfXvdkmxeX3N6cPkyHjUABh7rUp3sbdEjjG3h`
  (`scripts/devnet-pass.mts` reruns the whole life).
- **Tests on Meteora's real programs** (offline local chain with the real DBC and DAMM v2 programs):
  the coin life, graduated trading, LP claims, the mainnet preset, and money-safety rules.
- **Security:** three audits (Solana auditor skill checklists) plus money-flow audits; no open
  critical, high or medium findings. Rate limits shared across servers (Upstash Redis) plus a firewall.

**Numbers** (devnet, as of 11 Oct 2026, 13:27 IST): 7 coins launched on our config, 28 trades, 1.04 SOL volume, 5 graduations to DAMM v2, at least 0.0039 SOL in creator fees claimed. All from our own team testing so far.

_[Mainnet numbers: coins launched, trades, SOL volume, graduations, streamer earnings]_

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
