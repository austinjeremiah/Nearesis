import { afterAll, beforeAll, expect, it } from "vitest";
import { observe } from "@nearesis/acceptance";
import {
  PROVENANCE_ELEMENTS,
  missingProvenance,
  publicationSets,
  webEvidenceStatus,
} from "../../src/history/claims.ts";
import type { ProvenanceElement } from "../../src/history/claims.ts";
import { addEdge, addNode, newWs, world, wsVersion } from "../history/helpers.ts";
import type { World } from "../history/helpers.ts";

let w: World;
beforeAll(async () => (w = await world("w08")));
afterAll(async () => w?.db.drop());

const FULL = {
  resultRowIds: ["r1", "r2"],
  columnIds: ["volume_usd"],
  queryHash: "a".repeat(64),
  semanticModelVersion: "intents@1.2.0",
  rawSourceManifestHash: "b".repeat(64),
  quantModelRevision: "quant-r7",
};
const FIELD_OF: Record<ProvenanceElement, keyof typeof FULL> = {
  result_rows: "resultRowIds",
  result_columns: "columnIds",
  query_hash: "queryHash",
  semantic_version: "semanticModelVersion",
  source_manifest_hash: "rawSourceManifestHash",
  quant_model_revision: "quantModelRevision",
};

it("W08: unsupported claims are distinguishable and numeric claims need complete provenance", async () => {
  const { workspaceId } = await newWs(w);
  const result = await addNode(w, workspaceId, "statistical_result", "Result table r1");
  const eventSeq = async () =>
    Number(
      (
        await w.db.admin.query("SELECT max(seq) AS s FROM workspace_events WHERE workspace_id=$1", [
          workspaceId,
        ])
      ).rows[0].s,
    );

  // Fixture: 8 claims. The full-tuple claim, six that each lack one element, and one with only a contradicts edge.
  const claim = async (label: string, prov: Record<string, unknown>) =>
    addNode(w, workspaceId, "claim", label, { data: { numeric: true, value: 42, provenance: prov } });
  const full = await claim("full provenance", FULL);
  await addEdge(w, workspaceId, result, full, "supports");
  const holes: Record<string, string> = {};
  for (const el of PROVENANCE_ELEMENTS) {
    const prov: Record<string, unknown> = { ...FULL };
    delete prov[FIELD_OF[el]];
    const id = await claim(`missing ${el}`, prov);
    await addEdge(w, workspaceId, result, id, "supports");
    holes[el] = id;
  }
  const contra = await addNode(w, workspaceId, "claim", "only contradicted", {
    data: { numeric: false },
  });
  await addEdge(w, workspaceId, result, contra, "contradicts");
  // A web evidence item without a quoted fragment hash, relied on by a (non-numeric) claim.
  const web = await addNode(w, workspaceId, "source", "Web page", {
    data: {
      web: {
        title: "Intents overview",
        canonicalUrl: "https://example.org/intents",
        retrievedAt: "2026-11-09T10:00:00Z",
        confidenceTier: "high",
      },
    },
  });
  const webClaim = await addNode(w, workspaceId, "claim", "relies on web evidence", {
    data: { numeric: false },
  });
  await addEdge(w, workspaceId, web, webClaim, "supports");

  const bare = await addNode(w, workspaceId, "claim", "no supports edge at all", { data: { numeric: false } });

  const g1 = await w.k.graph.get(w.owner, workspaceId);
  const node = (id: string) => g1.nodes.find((n) => n.id === id)!;

  // (a) the six single-hole claims are stored, unsupported, with exactly the absent element named.
  expect(node(full).support).toBe("supported");
  expect(node(full).missing ?? []).toEqual([]);
  for (const el of PROVENANCE_ELEMENTS) {
    const n = node(holes[el]!);
    expect(n, `claim missing ${el} must be stored`).toBeDefined();
    expect(n.support).toBe("unsupported");
    expect(n.missing).toEqual([el]);
  }
  const storedClaims = (
    await w.db.admin.query("SELECT count(*) FROM evidence_nodes WHERE workspace_id=$1 AND kind='claim'", [
      workspaceId,
    ])
  ).rows[0].count;
  expect(Number(storedClaims)).toBe(10); // 1 + 6 + contradicts-only + web-reliant + bare: nothing dropped

  // (b) a claim with no supports edge is unsupported everywhere (projection, eligibility, export).
  expect(node(bare).support).toBe("unsupported");
  expect(node(contra).support).toBe("contradicted"); // only a contradicts edge: never "supported"
  expect(node(contra).support).not.toBe("supported");

  // (c) web evidence without fragment hash: unverified + missing, and the claim relying on it is unsupported.
  expect(node(web).confidenceTier).toBe("unverified");
  expect(node(web).missing).toEqual(["fragment_hash"]);
  expect(node(webClaim).support).toBe("unsupported");

  // (e) exclusion from supported publication, checked against the real eligibility list.
  const elig = await w.h.publicationEligibility(w.owner, workspaceId);
  expect(elig.supportedClaimIds).toEqual([full]);
  expect(elig.publicationEligibleIds).toEqual([full]);
  expect(elig.publishedNumbers).toEqual([{ claimId: full, value: 42 }]);
  const listed = elig.unsupportedSection.claims.map((c) => c.claimId).sort();
  expect(listed).toEqual([...Object.values(holes), contra, webClaim, bare].sort());
  expect(elig.unsupportedSection.label).toMatch(/UNSUPPORTED/);
  for (const el of PROVENANCE_ELEMENTS)
    expect(elig.unsupportedSection.claims.find((c) => c.claimId === holes[el])!.missing).toEqual([el]);

  // (d) completing the tuple flips the status in the next projection and appends an event.
  const before = await eventSeq();
  const fixed = holes.quant_model_revision!;
  await w.h.graphOps.updateNodeData(w.owner, workspaceId, {
    expectedVersion: await wsVersion(w, workspaceId),
    nodeId: fixed,
    data: { provenance: FULL },
    reason: "added the quant model revision",
  });
  const after = await eventSeq();
  expect(after).toBe(before + 1);
  const ev = (
    await w.db.admin.query(
      "SELECT event_type, payload FROM workspace_events WHERE workspace_id=$1 AND seq=$2",
      [workspaceId, after],
    )
  ).rows[0];
  expect(ev.event_type).toBe("claim.updated");
  expect(ev.payload.change).toBe("graph.node_data_updated");
  const g2 = await w.k.graph.get(w.owner, workspaceId);
  expect(g2.nodes.find((n) => n.id === fixed)!.support).toBe("supported");
  expect((await w.h.publicationEligibility(w.owner, workspaceId)).supportedClaimIds.sort()).toEqual(
    [full, fixed].sort(),
  );

  // Negative controls: a build that drops the quant-model-revision check, and one that lets an unsupported claim
  // into the eligibility list, must each fail the assertions above.
  const lenient = PROVENANCE_ELEMENTS.filter((e) => e !== "quant_model_revision");
  const holeData = { numeric: true, provenance: { ...FULL, quantModelRevision: undefined } };
  expect(missingProvenance(holeData)).toEqual(["quant_model_revision"]);
  expect(missingProvenance(holeData, lenient)).toEqual([]); // would flip (a): detected
  const claims = g1.nodes
    .filter((n) => n.type === "claim")
    .map((n) => ({ id: n.id, label: n.label, support: n.support, missing: n.missing, data: n.data }));
  expect(publicationSets(claims).publicationEligibleIds).toEqual([full]);
  expect(publicationSets(claims, { includeUnsupportedInEligible: true }).publicationEligibleIds.length).toBe(
    claims.length,
  ); // would break (e): detected
  expect(webEvidenceStatus({ web: { title: "t" } }).confidenceTier).toBe("unverified");

  observe({
    testId: "W08",
    observed: `10 claims stored (none dropped): the full-tuple claim is supported; each of the 6 single-hole claims is unsupported with missing=[that element]; a claim with no supports edge is unsupported and a contradicts-only claim is never supported; web item without fragment hash is unverified (missing [fragment_hash]) and its claim unsupported; eligibility list = [full claim] only, 9 unsupported claims listed with their missing provenance under an UNSUPPORTED label; completing the quant revision flipped its claim to supported and appended claim.updated (seq ${before}->${after}); both negative controls detected`,
    evidence: {
      claimsStored: 10,
      statuses: Object.fromEntries(Object.entries(holes).map(([k, id]) => [k, node(id).support])),
      eligible: elig.publicationEligibleIds.length,
      unsupportedListed: listed.length,
      eventSeq: [before, after],
    },
  });
});
