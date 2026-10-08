/** Ordered test steps that skip the rest after the first failure, so the real cause is the only red. */
import type { TestContext } from "node:test";

export function stepRunner(t: TestContext) {
  let broken = false;
  return (name: string, fn: () => Promise<void>) =>
    t.test(name, { skip: broken && "an earlier step failed" }, async () => {
      try {
        await fn();
      } catch (error) {
        broken = true;
        throw error;
      }
    });
}
