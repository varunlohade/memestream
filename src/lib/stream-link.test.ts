import assert from "node:assert/strict";
import { test } from "node:test";
import { metadataUri, parseStreamLink, streamLinkFromUri } from "./stream-link";

test("accepts Twitch, YouTube and Kick links and normalises them", () => {
  assert.equal(parseStreamLink("https://www.twitch.tv/mira_plays")?.url, "https://twitch.tv/mira_plays");
  assert.equal(parseStreamLink("https://youtu.be/dQw4w9WgXcQ")?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(parseStreamLink("https://www.youtube.com/live/dQw4w9WgXcQ")?.platform, "youtube");
  assert.equal(parseStreamLink("https://kick.com/chef-ren")?.url, "https://kick.com/chef-ren");
});

test("rejects other hosts, plain http and odd paths", () => {
  assert.equal(parseStreamLink("https://evil.example/twitch.tv/x"), null);
  assert.equal(parseStreamLink("http://twitch.tv/mira_plays"), null);
  assert.equal(parseStreamLink("https://twitch.tv/videos/123"), null);
  assert.equal(parseStreamLink("javascript:alert(1)"), null);
  assert.equal(parseStreamLink("not a url"), null);
});

test("YouTube and Twitch links give a player and a thumbnail; Kick has none", () => {
  const yt = parseStreamLink("https://www.youtube.com/live/jfKfPfyJRdk");
  assert.equal(yt?.embedUrl(""), "https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1&mute=1");
  assert.equal(yt?.thumbnailUrl, "https://i.ytimg.com/vi/jfKfPfyJRdk/hqdefault.jpg");
  assert.equal(parseStreamLink("https://twitch.tv/Mira_Plays")?.thumbnailUrl, "https://static-cdn.jtvnw.net/previews-ttv/live_user_mira_plays-640x360.jpg");
  assert.equal(parseStreamLink("https://kick.com/chef-ren")?.thumbnailUrl, null);
});

test("Twitch embeds carry the parent host", () => {
  const link = parseStreamLink("https://twitch.tv/mira_plays");
  assert.ok(link?.embedUrl("memestream.lol").includes("parent=memestream.lol"));
});

test("a link round-trips through the metadata URI and fits on-chain", () => {
  const link = parseStreamLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const mint = "Ebt5dA6zkvrin1jr4nvGdU5BbEC6BwV5pPVggs3Tcg9B";
  const uri = metadataUri("https://memestream.lol", mint, link);
  assert.ok(uri.startsWith(`https://memestream.lol/api/meta/${mint}?link=`));
  assert.ok(new TextEncoder().encode(uri).length <= 200);
  assert.equal(streamLinkFromUri(uri)?.url, link?.url);
  assert.equal(streamLinkFromUri(metadataUri("https://memestream.lol", mint, null)), null);
});
