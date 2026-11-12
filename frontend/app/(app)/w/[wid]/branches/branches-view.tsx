'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { SectionBar } from '@/components/nx/section';
import { Badge } from '@/components/nx/evidence';
import { Button, Card, EmptyState, Field, Input, KeyValues, Notice, Select, Textarea } from '@/components/nx/ui';
import { DataTable } from '@/components/nx/table';
import { qk } from '@/lib/api/keys';
import { formatUtc } from '@/lib/format';
import { hist, type Branch, type MergeConflict, type ObjectChange } from '@/lib/ws6/api';
import { ActionError, Hash, Json, Slot, useAction } from '@/components/ws6/common';

const NODE_KINDS = ['hypothesis', 'observation', 'query', 'model', 'source', 'marker', 'agent', 'statistical_result', 'claim', 'verification_artifact'];
const scopeKeys = (wid: string) => ({
  branches: [...qk.branches(wid)],
  proposals: [...qk.scope(wid), 'merge-proposals'],
});

function ChangeList({ changes }: { changes: ObjectChange[] }) {
  if (changes.length === 0) return <p className="small dim" data-testid="diff-empty">No differences.</p>;
  return (
    <ul className="col gap2" style={{ listStyle: 'none', padding: 0 }} data-testid="diff-list">
      {changes.map((c) => (
        <li key={c.objectId} className="col gap1" data-change={c.change}>
          <div className="row gap2">
            <Badge tone={c.change === 'added' ? 'ok' : c.change === 'removed' ? 'bad' : 'warn'}>{c.change}</Badge>
            <span className="mono small">{c.objectId}</span>
          </div>
          {c.before !== undefined && <Json value={{ before: c.before }} />}
          {c.after !== undefined && <Json value={{ after: c.after }} />}
        </li>
      ))}
    </ul>
  );
}

function BranchDetail({ wid, branch, branches, onProposed }: { wid: string; branch: Branch; branches: Branch[]; onProposed: (pid: string) => void }) {
  const diff = useQuery({ queryKey: [...qk.branches(wid), branch.id, 'diff'], queryFn: () => hist.diff(wid, branch.id) });
  const vsMain = useQuery({
    queryKey: [...qk.branches(wid), branch.id, 'diff-main'],
    queryFn: () => hist.diff(wid, branch.id, branches.find((b) => b.isMain)?.id),
    enabled: !branch.isMain && !!branches.find((b) => b.isMain),
  });
  const memory = useQuery({ queryKey: [...qk.branches(wid), branch.id, 'memory'], queryFn: () => hist.memory(wid, branch.id) });
  const [kind, setKind] = useState('claim');
  const [label, setLabel] = useState('');
  const keys = [[...qk.branches(wid), branch.id, 'diff'], [...qk.branches(wid), branch.id, 'diff-main']];
  const add = useAction(() => hist.addNode(wid, branch.id, { kind, label: label.trim() }), { invalidate: keys, onDone: () => setLabel('') });
  const propose = useAction(() => hist.propose(wid, branch.id), {
    invalidate: [scopeKeys(wid).proposals],
    onDone: (r) => onProposed(r.result.proposalId),
  });
  return (
    <div className="col gap3" data-testid="branch-detail">
      <KeyValues
        rows={[
          { k: 'Name', v: <span className="strong">{branch.name}</span> },
          { k: 'Status', v: <Badge tone={branch.status === 'active' ? 'ok' : ''}>{branch.status}</Badge> },
          { k: 'Base snapshot', v: <Hash value={branch.baseSnapshotId} /> },
          { k: 'Base event seq', v: <span className="mono">{branch.baseEventSeq}</span> },
          { k: 'Overlay revision', v: <span className="mono">{branch.overlayRevision}</span> },
        ]}
      />
      <div className="label">Diff against its base snapshot</div>
      <Slot q={diff}>{(d) => <ChangeList changes={d.changes} />}</Slot>
      {!branch.isMain && (
        <>
          <div className="label">Diff against main</div>
          <Slot q={vsMain}>{(d) => <ChangeList changes={d.changes} />}</Slot>
          <div className="label">Record a change on this branch</div>
          <div className="row gap2">
            <Select aria-label="Node kind" value={kind} onChange={(e) => setKind(e.target.value)} options={NODE_KINDS.map((k) => ({ value: k, label: k }))} data-testid="change-kind" />
            <Input aria-label="Node label" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="change-label" />
            <Button onClick={() => void add.run()} pending={add.pending} disabled={!label.trim()} disabledReason="Enter a label" data-testid="change-add">
              Add node
            </Button>
          </div>
          <ActionError error={add.error} />
          <div>
            <Button variant="primary" onClick={() => void propose.run()} pending={propose.pending} data-testid="propose-merge">
              Propose merge into main
            </Button>
          </div>
          <ActionError error={propose.error} />
        </>
      )}
      <div className="label">Branch memory</div>
      <Slot q={memory}>{(m) => (m.items.length ? <Json value={m.items} /> : <p className="small dim">No memory items on this branch.</p>)}</Slot>
    </div>
  );
}

function ProposalDetail({ wid, pid }: { wid: string; pid: string }) {
  const q = useQuery({ queryKey: [...scopeKeys(wid).proposals, pid], queryFn: () => hist.proposal(wid, pid) });
  const inv = [[...scopeKeys(wid).proposals], [...scopeKeys(wid).proposals, pid], [...qk.branches(wid)], [...qk.scope(wid), 'timeline']];
  const resolve = useAction((objectId: string, r: 'ours' | 'theirs' | 'keep_both') => hist.resolve(wid, pid, objectId, r), { invalidate: inv });
  const [ack, setAck] = useState(false);
  const accept = useAction(() => hist.decide(wid, pid, 'accept', ack), { invalidate: inv });
  const reject = useAction(() => hist.decide(wid, pid, 'reject'), { invalidate: inv });
  const [nodeId, setNodeId] = useState('');
  const [body, setBody] = useState('');
  const comments = useQuery({ queryKey: [...qk.scope(wid), 'comments'], queryFn: () => hist.comments(wid) });
  const addComment = useAction(() => hist.addComment(wid, nodeId.trim(), body.trim()), { invalidate: [[...qk.scope(wid), 'comments']], onDone: () => setBody('') });
  return (
    <Slot q={q}>
      {(p) => {
        const open = p.conflicts.filter((c: MergeConflict) => c.resolution === 'unresolved');
        const decided = p.status !== 'open';
        const nodeIds = Array.from(new Set(p.changes.map((c) => c.objectId).filter((id) => id.startsWith('node:')).map((id) => id.slice(5))));
        return (
          <div className="col gap3" data-testid="proposal-detail" data-status={p.status}>
            <KeyValues
              rows={[
                { k: 'Status', v: <Badge tone={p.status === 'open' ? 'info' : p.status === 'accepted' ? 'ok' : 'warn'}>{p.status}</Badge> },
                { k: 'Changes', v: <span className="mono">{p.changes.length}</span> },
                { k: 'Conflicts', v: <span className="mono">{p.conflicts.length}</span> },
                { k: 'Unresolved', v: <span className="mono" data-testid="unresolved-count">{open.length}</span> },
                { k: 'Decided', v: p.decidedAt ? <span className="mono">{formatUtc(p.decidedAt)}</span> : <span className="dim">not yet</span> },
              ]}
            />
            <div className="label">Changes</div>
            <ChangeList changes={p.changes} />
            {p.conflicts.length > 0 && (
              <>
                <div className="label">Conflicts</div>
                <ul className="col gap3" style={{ listStyle: 'none', padding: 0 }} data-testid="conflicts">
                  {p.conflicts.map((c) => (
                    <li key={c.objectId} className="col gap2" data-resolution={c.resolution}>
                      <div className="row gap2">
                        <span className="mono small">{c.objectId}</span>
                        <Badge tone={c.resolution === 'unresolved' ? 'warn' : 'ok'}>{c.resolution}</Badge>
                      </div>
                      <Json value={c} />
                      {!decided && (
                        <div className="row gap2">
                          {(['ours', 'theirs', 'keep_both'] as const).map((r) => (
                            <Button key={r} onClick={() => void resolve.run(c.objectId, r)} pending={resolve.pending} data-testid={`resolve-${r}`}>
                              Keep {r.replace('_', ' ')}
                            </Button>
                          ))}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <ActionError error={resolve.error} />
              </>
            )}
            {!decided && (
              <div className="col gap2">
                <label className="row gap2 small">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="ack-verdict" />
                  I acknowledge this merge may change a claim verdict
                </label>
                <div className="row gap2">
                  <Button variant="primary" onClick={() => void accept.run()} pending={accept.pending} disabled={open.length > 0} disabledReason="Resolve every conflict first" data-testid="merge-accept">
                    Accept merge into main
                  </Button>
                  <Button variant="danger" onClick={() => void reject.run()} pending={reject.pending} data-testid="merge-reject">
                    Reject
                  </Button>
                </div>
                <ActionError error={accept.error} />
                <ActionError error={reject.error} />
              </div>
            )}
            {decided && <Notice tone={p.status === 'accepted' ? 'ok' : 'info'} title={`Proposal ${p.status}`}>Decided {formatUtc(p.decidedAt)}.</Notice>}
            <div className="label">Reviewer comments</div>
            <Slot q={comments}>
              {(c) =>
                c.comments.length === 0 ? (
                  <p className="small dim">No review comments yet.</p>
                ) : (
                  <ul className="col gap2" data-testid="comments">
                    {c.comments.map((x, i) => (
                      <li key={x.id ?? i} className="small">
                        <span className="mono tiny dim">{x.nodeId?.slice(0, 8)} </span>
                        {x.body}
                      </li>
                    ))}
                  </ul>
                )
              }
            </Slot>
            <div className="col gap2">
              <Field label="Comment on a node" help={nodeIds.length ? 'Nodes touched by this proposal are suggested.' : 'Paste the node id (UUID) to comment on.'}>
                <Input list="proposal-nodes" value={nodeId} onChange={(e) => setNodeId(e.target.value)} placeholder="Node id" data-testid="comment-node" />
              </Field>
              <datalist id="proposal-nodes">
                {nodeIds.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Comment" aria-label="Comment" data-testid="comment-body" />
              <div>
                <Button onClick={() => void addComment.run()} pending={addComment.pending} disabled={!nodeId.trim() || !body.trim()} disabledReason="Name a node and write a comment" data-testid="comment-add">
                  Add comment
                </Button>
              </div>
              <ActionError error={addComment.error} />
            </div>
          </div>
        );
      }}
    </Slot>
  );
}

export default function BranchesView({ wid }: { wid: string }) {
  const branches = useQuery({ queryKey: qk.branches(wid), queryFn: () => hist.branches(wid) });
  const snaps = useQuery({ queryKey: qk.snapshots(wid), queryFn: () => hist.snapshots(wid) });
  const proposals = useQuery({ queryKey: scopeKeys(wid).proposals, queryFn: () => hist.proposals(wid) });
  const [bid, setBid] = useState<string | null>(null);
  const [pid, setPid] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [from, setFrom] = useState('');
  const create = useAction(() => hist.createBranch(wid, { name: name.trim(), fromSnapshotId: from }), {
    invalidate: [scopeKeys(wid).branches],
    onDone: (r) => {
      setName('');
      setBid(r.result.branchId);
    },
  });
  const all = branches.data?.branches ?? [];
  const sel = all.find((b) => b.id === bid);
  const snapRows = snaps.data?.snapshots ?? [];
  const nameOf = (id: string) => all.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <section>
        <SectionBar title="Branches" number="001" />
        <div className="grid c2">
          <Card title="All branches">
            <Slot q={branches}>
              {() => (
                <DataTable
                  caption="Branches"
                  rows={all}
                  rowKey={(b) => b.id}
                  onRowClick={(b) => setBid(b.id)}
                  columns={[
                    { key: 'name', header: 'Name', render: (b) => <span className="strong">{b.name}</span> },
                    { key: 'main', header: '', render: (b) => (b.isMain ? <Badge tone="ink">main</Badge> : null) },
                    { key: 'status', header: 'Status', render: (b) => b.status },
                    { key: 'rev', header: 'Overlay rev', numeric: true, render: (b) => b.overlayRevision },
                    { key: 'at', header: 'Created', render: (b) => <span className="mono small">{formatUtc(b.createdAt)}</span> },
                  ]}
                />
              )}
            </Slot>
            <div className="col gap2" style={{ marginTop: 12 }}>
              <div className="label">New branch from a snapshot</div>
              {snapRows.length === 0 ? (
                <p className="small dim" data-testid="no-snapshots">A branch starts from a snapshot. Take one in the time machine first.</p>
              ) : (
                <div className="row gap2">
                  <Input aria-label="Branch name" placeholder="Branch name" value={name} onChange={(e) => setName(e.target.value)} data-testid="branch-name" />
                  <Select aria-label="Base snapshot" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="branch-from" options={[{ value: '', label: 'Base snapshot' }, ...snapRows.map((s) => ({ value: s.id, label: s.label }))]} />
                  <Button variant="primary" onClick={() => void create.run()} pending={create.pending} disabled={!name.trim() || !from} disabledReason="Name the branch and pick a snapshot" data-testid="branch-create">
                    Create branch
                  </Button>
                </div>
              )}
              <ActionError error={create.error} />
            </div>
          </Card>
          <Card title="Branch detail">
            {sel ? <BranchDetail key={sel.id} wid={wid} branch={sel} branches={all} onProposed={setPid} /> : <EmptyState title="Select a branch" body="Choose a branch to see its diff, memory and actions." />}
          </Card>
        </div>
      </section>
      <section>
        <SectionBar title="Merge proposals" number="002" />
        <div className="grid c2">
          <Card title="Proposals">
            <Slot q={proposals}>
              {(p) => (
                <DataTable
                  caption="Merge proposals"
                  rows={[...p.proposals].reverse()}
                  rowKey={(r) => r.id}
                  empty={{ title: 'No merge proposals', body: 'Propose a merge from a branch to review its changes against main.' }}
                  onRowClick={(r) => setPid(r.id)}
                  columns={[
                    { key: 'src', header: 'From', render: (r) => nameOf(r.sourceBranchId) },
                    { key: 'tgt', header: 'Into', render: (r) => nameOf(r.targetBranchId) },
                    { key: 'st', header: 'Status', render: (r) => <Badge tone={r.status === 'open' ? 'info' : r.status === 'accepted' ? 'ok' : 'warn'}>{r.status}</Badge> },
                    { key: 'ch', header: 'Changes', numeric: true, render: (r) => r.changeCount },
                    { key: 'co', header: 'Conflicts', numeric: true, render: (r) => r.conflictCount },
                  ]}
                />
              )}
            </Slot>
          </Card>
          <Card title="Proposal">{pid ? <ProposalDetail key={pid} wid={wid} pid={pid} /> : <EmptyState title="Select a proposal" body="Open a proposal to review changes, resolve conflicts and decide." />}</Card>
        </div>
      </section>
    </>
  );
}
