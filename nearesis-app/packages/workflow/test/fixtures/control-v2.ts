import { proxyActivities } from "@temporalio/workflow";

const acts = proxyActivities<{ stepA(): Promise<string>; stepB(): Promise<string> }>({
  startToCloseTimeout: "10 seconds",
});
/** fx.temporal.nondeterministic (v2 = deliberately incompatible): command order changed, so replay of v1 history must fail. */
export async function ControlWorkflow(): Promise<string> {
  const b = await acts.stepB();
  const a = await acts.stepA();
  return a + b;
}
