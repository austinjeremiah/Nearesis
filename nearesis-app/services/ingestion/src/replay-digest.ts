import { replayDetailed } from "./replay.ts";

/** Digest of a snapshot's replay, independent of the digest recorded in its manifest. Used by the fixture generator. */
export async function computeSnapshotDigest(id: string): Promise<string> {
  return (await replayDetailed(id)).output.digest;
}
