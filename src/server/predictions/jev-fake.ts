/** TEST ONLY: well-formed jev answers for a fake fetch. */

export const REASON_IDS = ["OK", "HATE", "SEXUAL", "VIOLENCE", "HARASSMENT", "SELF_HARM", "PRIVATE_PERSON", "ILLEGAL", "SPAM", "NOT_YES_NO", "GIBBERISH"];

export const WINDOW_IDS = ["W1", "W2", "W5", "W10", "W30", "W60"];

/** A well-formed answer to one choice question: `choice` at 0.9, the rest split evenly. */
const choiceAnswer = (ids: string[], choice: string, confidence = 0.9) => {
  const rest = (1 - 0.9) / (ids.length - 1);
  return { choice, probabilities: Object.fromEntries(ids.map((id) => [id, id === choice ? 0.9 : rest])), confidence };
};

/** A well-formed jev answer; with `window`, it also picks that betting window (else it gives none). */
export function jevAnswer(verdict: "APPROVE" | "REJECT", confidence = 0.9, reason = verdict === "APPROVE" ? "OK" : "SPAM", window?: { choice: string; confidence?: number }) {
  const other = verdict === "APPROVE" ? "REJECT" : "APPROVE";
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: { choice: verdict, probabilities: { [verdict]: confidence, [other]: 1 - confidence }, confidence },
      reason: choiceAnswer(REASON_IDS, reason),
      ...(window ? { window: choiceAnswer(WINDOW_IDS, window.choice, window.confidence) } : {}),
    },
  };
}

/**
 * Realistic stream questions, each with the window it should get: fixtures for the review's
 * criteria wording, and for a one-off live check. All should approve.
 */
export const STREAM_QUESTIONS = [
  ["Will he reach the airport gate in 10 minutes?", "W10"],
  ["Will chat hit 100 messages?", "W5"],
  ["Will she win this round?", "W30"],
  ["Will he land this jump first try?", "W1"],
  ["Will they finish the boss fight before the stream ends?", "W60"],
  ["Will the streamer eat the whole burger in 2 minutes?", "W2"],
] as const;

/** A well-formed jev answer to the AI check's "happened" question. */
export function happenedAnswer(choice: "YES" | "NO" | "UNCLEAR", confidence = 0.9, probability = confidence) {
  const rest = (1 - probability) / 2;
  const probabilities = Object.fromEntries(["YES", "NO", "UNCLEAR"].map((id) => [id, id === choice ? probability : rest]));
  return { model: "jev-1.13.0", answers: { happened: { choice, probabilities, confidence } } };
}

/** A well-formed OpenRouter chat answer carrying `text`. */
export const visionAnswer = (text: string) => ({ id: "gen-test", choices: [{ message: { role: "assistant", content: text } }] });

/** The vision model's facts answer: each fact with where it was seen (game_ui unless given). */
export const factsAnswer = (...facts: (string | [string, string])[]) =>
  visionAnswer(JSON.stringify({ facts: facts.map((f) => (typeof f === "string" ? { fact: f, source: "game_ui" } : { fact: f[0], source: f[1] })) }));
