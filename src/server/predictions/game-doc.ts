/** A coin's game as stored, and the migration of documents saved before several predictions could be live. */
import { type Game, newGame, type Prediction } from "@/lib/predictions/engine";

/** `live` was one prediction or null before several could be live: `X` loads as `[X]`, null as `[]`. */
const liveList = (live: unknown): Prediction[] => (Array.isArray(live) ? live : live ? [live as Prediction] : []);

export function parseGame(json: string | null, streamer: string): Game {
  const game: Game = json ? { ...newGame(streamer), ...JSON.parse(json) } : newGame(streamer);
  game.live = liveList(game.live);
  game.creator = streamer;
  return game;
}
