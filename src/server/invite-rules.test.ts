import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataUri, parseStreamLink, type StreamLink } from "@/lib/stream-link";
import { UserError } from "./errors";
import { assertCanLaunch, checkLaunch, coinSeal, type FetchVideo, type InviteSettings, isSealed, parseInvites, settingsFromEnv, type YoutubeVideo } from "./invite-rules";

const SECRET = "s".repeat(32);
const WALLET = "Ebt5dA6zkvrin1jr4nvGdU5BbEC6BwV5pPVggs3Tcg9B";
const OTHER_WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MINT = "So11111111111111111111111111111111111111112";
const CHANNEL = "UCmira000000000000000000";
const OTHER_CHANNEL = "UCother00000000000000000";
const link = parseStreamLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ") as StreamLink;

const video = (over: Partial<YoutubeVideo> = {}): YoutubeVideo => ({ channelId: CHANNEL, channelTitle: "Mira", broadcast: "live", ...over });
/** Invite mode with WALLET invited for CHANNEL; counts YouTube calls. */
function inviteMode(found: YoutubeVideo | null) {
  const calls: string[] = [];
  const settings: InviteSettings = {
    mode: "invite",
    secret: SECRET,
    invites: new Map([[WALLET, CHANNEL]]),
    fetchVideo: async (id) => {
      calls.push(id);
      return found;
    },
  };
  return { settings, calls };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof UserError, `expected a UserError, got ${error}`);
    return error.message;
  }
  assert.fail("expected a refusal");
}

test("an invited wallet launching on its own live channel gets a sealed coin", async () => {
  const seal = await assertCanLaunch(inviteMode(video()).settings, WALLET, link);
  assert.ok(seal);
  const uri = metadataUri("https://memestream-iota.vercel.app", MINT, link, seal(MINT));
  assert.ok(new TextEncoder().encode(uri).length <= 200, `${uri} fits on-chain`);
  assert.ok(isSealed(SECRET, MINT, uri));
});

test("a scheduled stream counts as live", async () => {
  assert.ok(await assertCanLaunch(inviteMode(video({ broadcast: "upcoming" })).settings, WALLET, link));
});

test("launches are refused unless the wallet is invited and the stream is live on its own channel", async () => {
  assert.match(await refusal(assertCanLaunch(inviteMode(video()).settings, OTHER_WALLET, link)), /wallet isn't invited/);
  assert.match(await refusal(assertCanLaunch(inviteMode(null).settings, WALLET, link)), /can't find that video/);
  // An invited streamer can't launch on someone else's stream.
  assert.match(await refusal(assertCanLaunch(inviteMode(video({ channelId: OTHER_CHANNEL })).settings, WALLET, link)), /isn't on your channel/);
  assert.match(await refusal(assertCanLaunch(inviteMode(video({ broadcast: "none" })).settings, WALLET, link)), /live or scheduled/);
  assert.match(await refusal(assertCanLaunch({ mode: "closed", secret: SECRET }, WALLET, link)), /invite-only/);
  const twitch = parseStreamLink("https://twitch.tv/mira") as StreamLink;
  assert.match(await refusal(assertCanLaunch(inviteMode(video()).settings, WALLET, twitch)), /YouTube live link/);
});

test("a wallet that isn't invited never costs a YouTube call", async () => {
  const { settings, calls } = inviteMode(video());
  assert.deepEqual(await checkLaunch(settings, OTHER_WALLET, link), { mode: "invite", invited: false, channel: null, ownChannel: false, live: false });
  assert.deepEqual(calls, []);
});

test("the check answers the wallet alone, then the stream", async () => {
  const { settings, calls } = inviteMode(video());
  assert.deepEqual(await checkLaunch(settings, WALLET, null), { mode: "invite", invited: true, channel: null, ownChannel: false, live: false });
  assert.deepEqual(calls, []);
  assert.deepEqual(await checkLaunch(settings, WALLET, link), { mode: "invite", invited: true, channel: "Mira", ownChannel: true, live: true });
  assert.deepEqual(await checkLaunch({ mode: "open", secret: null }, WALLET, link), { mode: "open" });
});

test("YouTube being down is a retryable user error, not a crash", async () => {
  const down: FetchVideo = async () => {
    throw new Error("socket hang up");
  };
  const settings: InviteSettings = { mode: "invite", secret: SECRET, invites: new Map([[WALLET, CHANNEL]]), fetchVideo: down };
  assert.match(await refusal(assertCanLaunch(settings, WALLET, link)), /Couldn't reach YouTube/);
});

test("open mode lets anyone launch, unsealed", async () => {
  assert.equal(await assertCanLaunch({ mode: "open", secret: null }, OTHER_WALLET, link), null);
});

test("only this server's seal for this mint and video verifies a coin", () => {
  const sealed = metadataUri("https://memestream.lol", MINT, link, coinSeal(SECRET, MINT, "dQw4w9WgXcQ"));
  assert.ok(isSealed(SECRET, MINT, sealed));
  assert.ok(!isSealed(null, MINT, sealed), "no secret, nothing verifies");
  assert.ok(!isSealed("t".repeat(32), MINT, sealed), "another secret's seal");
  assert.ok(!isSealed(SECRET, "11111111111111111111111111111111", sealed), "a seal copied onto another coin");
  const otherVideo = parseStreamLink("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  assert.ok(!isSealed(SECRET, MINT, metadataUri("https://memestream.lol", MINT, otherVideo, coinSeal(SECRET, MINT, "dQw4w9WgXcQ"))), "a seal moved to another stream");
  assert.ok(!isSealed(SECRET, MINT, metadataUri("https://memestream.lol", MINT, link)), "no seal");
  assert.ok(!isSealed(SECRET, MINT, metadataUri("https://memestream.lol", MINT, link, "AAAAAAAAAAAAAAAA")), "a made-up seal");
  assert.ok(!isSealed(SECRET, MINT, "not a url"));
});

test("invites parse as wallet:channel pairs; a malformed entry invites nobody", () => {
  const invites = parseInvites(` ${WALLET}:${CHANNEL} , ${OTHER_WALLET} : ${OTHER_CHANNEL}, nonsense, ${WALLET}, x:${CHANNEL}, ${WALLET}:UCshort, ${WALLET}:${CHANNEL}:extra `);
  assert.deepEqual([...invites], [
    [WALLET, CHANNEL],
    [OTHER_WALLET, OTHER_CHANNEL],
  ]);
  assert.equal(parseInvites("").size, 0);
});

test("settings: anything missing is closed; open is never allowed on mainnet", () => {
  const fetchWith = () => async () => null;
  const full = { MEMESTREAM_VERIFY_SECRET: SECRET, YOUTUBE_API_KEY: "key", MEMESTREAM_INVITES: `${WALLET}:${CHANNEL}` };
  const invite = settingsFromEnv(full, fetchWith);
  assert.equal(invite.mode, "invite");
  assert.equal(invite.mode === "invite" && invite.invites.get(WALLET), CHANNEL);
  assert.equal(settingsFromEnv({}, fetchWith).mode, "closed");
  assert.equal(settingsFromEnv({ ...full, YOUTUBE_API_KEY: "" }, fetchWith).mode, "closed");
  assert.equal(settingsFromEnv({ ...full, MEMESTREAM_INVITES: "typo" }, fetchWith).mode, "closed");
  const short = settingsFromEnv({ ...full, MEMESTREAM_VERIFY_SECRET: "short" }, fetchWith);
  assert.deepEqual(short, { mode: "closed", secret: null }, "a short secret is ignored, so it can't verify coins either");
  assert.equal(settingsFromEnv({ MEMESTREAM_OPEN_LAUNCH: "1" }, fetchWith).mode, "open");
  assert.equal(settingsFromEnv({ MEMESTREAM_OPEN_LAUNCH: "1", MEMESTREAM_WALLET_CHAIN: "solana:mainnet" }, fetchWith).mode, "closed");
  assert.equal(settingsFromEnv({ ...full, MEMESTREAM_OPEN_LAUNCH: "1", MEMESTREAM_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }, fetchWith).mode, "invite");
});
