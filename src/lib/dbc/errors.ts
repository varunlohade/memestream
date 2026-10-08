/** An error caused by the caller's input or the coin's state, safe to show to a user. */
export class InputError extends Error {
  override name = "InputError";
}
