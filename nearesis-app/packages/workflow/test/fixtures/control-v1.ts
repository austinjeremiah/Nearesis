import { proxyActivities } from "@temporalio/workflow";

const acts = proxyActivities<{ stepA(): Promise<string>; stepB(): Promise<string> }>({
  startToCloseTimeout: "10 seconds",
});
/** fx.temporal.nondeterministic (v1 = the recorded behaviour): stepA then stepB. */
export async function ControlWorkflow(): Promise<string> {
  const a = await acts.stepA();
  const b = await acts.stepB();
  return a + b;
}
