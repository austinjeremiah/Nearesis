"use client";
import { AgentRole } from "@nearesis/contracts";
import { Button } from "@nearesis/ui";
import { useState } from "react";
import type { MonitoringStore } from "../../lib/monitoring/use-monitoring.ts";
import { explainReason } from "./shared.tsx";

const ROLES = AgentRole.options.filter((r) => r !== "director");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const list = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Delegation scope (ch.11): what a member may hand to agents. The kernel is the authority: the form is available to
 * everyone and an analyst's attempt is rejected with the kernel's reason, which is explained here, never hidden.
 */
export function DelegationTab({ store }: { store: MonitoringStore }) {
  const [userId, setUserId] = useState("");
  const [agents, setAgents] = useState<string[]>(["quant"]);
  const [grants, setGrants] = useState("");
  const [delegateTo, setDelegateTo] = useState("");
  const [tokens, setTokens] = useState("50000");
  const [toolCalls, setToolCalls] = useState("50");
  const [usd, setUsd] = useState("5");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!UUID.test(userId.trim())) return setMsg({ ok: false, text: "The member id must be a UUID." });
    const targets = list(delegateTo);
    if (targets.some((t) => !UUID.test(t)))
      return setMsg({ ok: false, text: "Delegate-to ids must be UUIDs." });
    setBusy(true);
    const r = await store.act((api) =>
      api.setDelegationScope({
        userId: userId.trim(),
        agents,
        grants: list(grants),
        delegateTo: targets,
        maxBudget: { tokens: Number(tokens), toolCalls: Number(toolCalls), usd: Number(usd) },
      }),
    );
    setBusy(false);
    setMsg(
      r.ok
        ? { ok: true, text: "Delegation scope saved." }
        : { ok: false, text: `${r.reasonCode}: ${explainReason(r.reasonCode) ?? r.message}` },
    );
  };
  return (
    <form
      className="nz-form"
      data-testid="delegation-form"
      aria-label="Delegation scope"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="nz-h3">Delegation scope</h3>
      <p className="nz-sb-meta">
        Only owners and admins can grant a scope. Without one an analyst cannot assign agents
        (DELEGATION_SCOPE_REQUIRED). Owners and admins hold an implicit, unbounded scope. Scopes cannot be
        listed here: the API only accepts writes.
      </p>
      <label className="nz-field-block">
        Member id
        <input
          className="nz-input nz-wide"
          data-testid="scope-user"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        />
      </label>
      <fieldset className="nz-fieldset">
        <legend>Agents</legend>
        <div className="nz-checks">
          {ROLES.map((r) => (
            <label key={r} className="nz-field-inline">
              <input
                type="checkbox"
                checked={agents.includes(r)}
                data-testid={`scope-agent-${r}`}
                onChange={(e) => setAgents((a) => (e.target.checked ? [...a, r] : a.filter((x) => x !== r)))}
              />
              {r}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="nz-field-block">
        Capability grants (comma separated)
        <input
          className="nz-input nz-wide"
          data-testid="scope-grants"
          value={grants}
          onChange={(e) => setGrants(e.target.value)}
        />
      </label>
      <label className="nz-field-block">
        May delegate to (member ids)
        <input
          className="nz-input nz-wide"
          data-testid="scope-delegate-to"
          value={delegateTo}
          onChange={(e) => setDelegateTo(e.target.value)}
        />
      </label>
      <div className="nz-row nz-row-wrap">
        <label className="nz-field-block">
          Max tokens
          <input
            className="nz-input"
            data-testid="scope-tokens"
            value={tokens}
            onChange={(e) => setTokens(e.target.value)}
          />
        </label>
        <label className="nz-field-block">
          Max tool calls
          <input
            className="nz-input"
            data-testid="scope-toolcalls"
            value={toolCalls}
            onChange={(e) => setToolCalls(e.target.value)}
          />
        </label>
        <label className="nz-field-block">
          Max USD
          <input
            className="nz-input"
            data-testid="scope-usd"
            value={usd}
            onChange={(e) => setUsd(e.target.value)}
          />
        </label>
      </div>
      {msg && (
        <p
          role={msg.ok ? "status" : "alert"}
          className={msg.ok ? "nz-sb-meta" : "nz-error"}
          data-testid={msg.ok ? "scope-saved" : "scope-error"}
        >
          {msg.text}
        </p>
      )}
      <div className="nz-page-actions">
        <Button type="submit" variant="primary" size="sm" data-testid="scope-save" disabled={busy}>
          Save scope
        </Button>
      </div>
    </form>
  );
}
