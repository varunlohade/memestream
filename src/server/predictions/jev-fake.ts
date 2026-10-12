/** TEST ONLY: well-formed jev answers for a fake fetch. */

export const REASON_IDS = ["OK", "HATE", "SEXUAL", "VIOLENCE", "HARASSMENT", "SELF_HARM", "PRIVATE_PERSON", "ILLEGAL", "SPAM", "NOT_YES_NO", "GIBBERISH"];

/** A well-formed jev answer. */
export function jevAnswer(verdict: "APPROVE" | "REJECT", confidence = 0.9, reason = verdict === "APPROVE" ? "OK" : "SPAM") {
  const other = verdict === "APPROVE" ? "REJECT" : "APPROVE";
  const rest = (1 - 0.9) / (REASON_IDS.length - 1);
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: { choice: verdict, probabilities: { [verdict]: confidence, [other]: 1 - confidence }, confidence },
      reason: { choice: reason, probabilities: Object.fromEntries(REASON_IDS.map((id) => [id, id === reason ? 0.9 : rest])), confidence: 0.9 },
    },
  };
}

/** A well-formed jev answer to the AI check's "happened" question. */
export function happenedAnswer(choice: "YES" | "NO" | "UNCLEAR", confidence = 0.9, probability = confidence) {
  const rest = (1 - probability) / 2;
  const probabilities = Object.fromEntries(["YES", "NO", "UNCLEAR"].map((id) => [id, id === choice ? probability : rest]));
  return { model: "jev-1.13.0", answers: { happened: { choice, probabilities, confidence } } };
}

/** A well-formed OpenRouter chat answer carrying `text`. */
export const visionAnswer = (text: string) => ({ id: "gen-test", choices: [{ message: { role: "assistant", content: text } }] });
