import { AssetAlias, ContractRegistryEntry } from "@nearesis/contracts";
import { fixtureHash, loadManifest, readFixtureFile } from "@nearesis/test-fixtures";
import { z } from "zod";
import { BQ_ADAPTER_VERSION } from "./adapters/bigquery.ts";
import { EXPLORER_ADAPTER_VERSION } from "./adapters/explorer.ts";
import {
  explorerSchemaFingerprint,
  normStatus,
  parseExplorerPage,
  reconcileSwap,
  swapKeyOf,
  type StoredSwap,
} from "./adapters/explorer-parse.ts";
import { ONECLICK_ADAPTER_VERSION, TokenResponse, classifyQuote } from "./adapters/oneclick.ts";
import { PRICE_ADAPTER_VERSION, buildPriceRows } from "./adapters/price.ts";
import { MemoryObjectStore } from "./archive/object-store.ts";
import { RawArchive } from "./archive/archive.ts";
import { CredentialSource } from "./http/credentials.ts";
import { IngestionError } from "./errors.ts";
import { sha256Hex } from "./hash.ts";
import { normalize, type ReplayBundle } from "./normalize.ts";
import type { NormalizedOutput, SourceLabel } from "./normalized/types.ts";
import { AssetRegistry } from "./registry/assets.ts";
import { ContractRegistry } from "./registry/contracts.ts";
import { Snapshot, type PageRef } from "./snapshot.ts";

const label = (env: "fixture_synthetic" | "fixture_recorded"): SourceLabel =>
  env === "fixture_synthetic" ? "SYNTHETIC" : "RECORDED";
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

export interface ReplayReport {
  snapshotId: string;
  output: NormalizedOutput;
  expectedDigest: string | null;
  digestMatches: boolean | null;
  manifestSha256: string;
  credentialReads: number;
  adapterModes: Record<string, string>;
}

export interface ReplayOptions {
  /** Defaults to a deny-all CredentialSource. Replay never needs credentials. */
  credentials?: CredentialSource;
}

/** Deterministic replay of every adapter over a snapshot's fixture files. No network, no credentials. */
export async function replay(snapshotId: string, opts: ReplayOptions = {}): Promise<NormalizedOutput> {
  return (await replayDetailed(snapshotId, opts)).output;
}

export async function replayDetailed(snapshotId: string, opts: ReplayOptions = {}): Promise<ReplayReport> {
  const creds = opts.credentials ?? CredentialSource.denyAll();
  const manifest = loadManifest(snapshotId);
  const snap = Snapshot.parse(JSON.parse(text(readFixtureFile(snapshotId, "snapshot.json"))));
  if (snap.snapshotId !== snapshotId)
    throw new IngestionError("INVALID_INPUT", false, { reason: "snapshot id mismatch" });
  const store = new MemoryObjectStore();
  const archive = new RawArchive(store, null);
  const bundle: ReplayBundle = { snapshotId, mode: "replay", nowMs: Date.parse(snap.replayNowUTC) };

  const archiveFile = async (
    providerId: "near-explorer" | "intents-1click" | "coingecko" | "near-bigquery" | "near-contract-registry",
    file: string,
    fetchedAtUTC: string,
    env: "fixture_synthetic" | "fixture_recorded",
    adapterVersion: string,
  ): Promise<string> => {
    const a = await archive.archive({
      providerId,
      adapterVersion,
      method: "GET",
      url: `https://replay.invalid/${snapshotId}/${file}`,
      sourceEnvironment: env,
      fetchedAtUTC,
      receivedAtUTC: fetchedAtUTC,
      providerEventAtUTC: null,
      providerEventAtNullReason: "replayed fixture",
      responseStatus: 200,
      contentType: "application/json",
      payload: readFixtureFile(snapshotId, file),
      privacyVisibility: "public",
      completeness: "complete",
    });
    return a.observation.payloadObjectHash;
  };

  if (snap.explorer) {
    const ex = snap.explorer;
    const swaps = new Map<string, { stored: StoredSwap; version: number }>();
    const days: NonNullable<ReplayBundle["explorer"]>["days"] = [];
    const gaps: NonNullable<ReplayBundle["explorer"]>["gaps"] = [];
    let fp: string | null = null;
    const ingestPage = async (p: PageRef): Promise<{ ok: boolean; count: number }> => {
      if (p.status !== 200 || !p.file) return { ok: false, count: 0 };
      const bytes = readFixtureFile(snapshotId, p.file);
      const headers = p.headersFile
        ? (JSON.parse(text(readFixtureFile(snapshotId, p.headersFile))) as Record<string, string>)
        : {};
      const hash = await archiveFile(
        "near-explorer",
        p.file,
        p.fetchedAtUTC,
        ex.environment,
        EXPLORER_ADAPTER_VERSION,
      );
      const parsed = parseExplorerPage(bytes, headers);
      if (!parsed.ok) {
        gaps.push({
          fromUTC: p.fetchedAtUTC,
          toUTC: p.fetchedAtUTC,
          state: "partial",
          reasonCode: `QUARANTINED_${parsed.reasonCode}`,
        });
        return { ok: false, count: 0 };
      }
      if (parsed.items.length && !fp) fp = explorerSchemaFingerprint(parsed.items).slice(0, 16);
      const version = Date.parse(p.fetchedAtUTC);
      for (const t of parsed.items) {
        const incoming: StoredSwap = {
          swapKey: swapKeyOf(t),
          status: normStatus(t.status),
          createdAt: new Date(t.createdAt).toISOString(),
          amountIn: t.amountIn,
          amountOut: t.amountOut,
          rawObjectHash: hash,
          record: t,
        };
        const action = reconcileSwap(swaps.get(incoming.swapKey)?.stored, incoming);
        if (action === "insert" || action === "update")
          swaps.set(incoming.swapKey, { stored: incoming, version });
      }
      return { ok: true, count: parsed.items.length };
    };
    for (const s of ex.streams) {
      if (s.kind === "pages") {
        for (const p of s.pages) {
          const r = await ingestPage(p);
          if (!r.ok) {
            if (p.status !== 200 || !p.file)
              gaps.push({
                fromUTC: p.fetchedAtUTC,
                toUTC: p.fetchedAtUTC,
                state: "unavailable",
                reasonCode: `HTTP_${p.status}`,
              });
            break; // cursor is never advanced past a failed page
          }
        }
      } else {
        for (const d of s.days) {
          const dayStart = `${d.day}T00:00:00.000Z`;
          const dayEnd = `${d.day}T23:59:59.999Z`;
          const first = d.pages[0];
          const version = Date.parse((d.pages.at(-1) ?? first)?.fetchedAtUTC ?? snap.replayNowUTC);
          if (!first || first.status !== 200 || !first.file) {
            days.push({ day: d.day, state: "unavailable", reason: "PROVIDER_GAP", version });
            gaps.push({ fromUTC: dayStart, toUTC: dayEnd, state: "unavailable", reasonCode: "PROVIDER_GAP" });
            continue;
          }
          let state: "complete" | "partial" = "complete";
          let reason: string | null = null;
          for (const [i, p] of d.pages.entries()) {
            const r = await ingestPage(p);
            if (!r.ok) {
              state = "partial";
              reason = p.status !== 200 ? `INCOMPLETE_HTTP_${p.status}` : "QUARANTINED_BODY";
              break;
            }
            if (r.count < ex.pageSize) break; // short page = end of day
            if (i === d.pages.length - 1) {
              state = "partial"; // a full last page with no end-of-data confirmation
              reason = "INCOMPLETE_NO_END_OF_DATA";
            }
          }
          days.push({ day: d.day, state, reason, version });
          if (state !== "complete")
            gaps.push({ fromUTC: dayStart, toUTC: dayEnd, state, reasonCode: reason ?? "PARTIAL" });
        }
      }
    }
    bundle.explorer = {
      label: label(ex.environment),
      adapterVersion: EXPLORER_ADAPTER_VERSION,
      swaps: [...swaps.values()],
      days,
      gaps,
      schemaFingerprint: fp,
    };
  }

  if (snap.registry) {
    const r = snap.registry;
    const aliases = r.aliases
      ? z.array(AssetAlias).parse(JSON.parse(text(readFixtureFile(snapshotId, r.aliases))))
      : [];
    const entries = r.contracts
      ? z.array(ContractRegistryEntry).parse(JSON.parse(text(readFixtureFile(snapshotId, r.contracts))))
      : [];
    const hashes: string[] = [];
    if (r.aliases)
      hashes.push(
        await archiveFile(
          "near-contract-registry",
          r.aliases,
          snap.replayNowUTC,
          r.environment,
          "registry-1.0.0",
        ),
      );
    if (r.contracts)
      hashes.push(
        await archiveFile(
          "near-contract-registry",
          r.contracts,
          snap.replayNowUTC,
          r.environment,
          "registry-1.0.0",
        ),
      );
    bundle.registry = {
      label: label(r.environment),
      adapterVersion: "registry-1.0.0",
      aliases,
      assets: aliases.length ? new AssetRegistry(aliases) : null,
      contracts: entries.length ? new ContractRegistry(entries) : null,
      rawHash: sha256Hex(hashes.join(",")),
      version: Date.parse(snap.replayNowUTC),
    };
  }

  if (snap.oneclick) {
    const o = snap.oneclick;
    const tokensRaw = JSON.parse(text(readFixtureFile(snapshotId, o.tokens.file))) as unknown[];
    await archiveFile(
      "intents-1click",
      o.tokens.file,
      o.tokens.fetchedAtUTC,
      o.environment,
      ONECLICK_ADAPTER_VERSION,
    );
    const tokens = tokensRaw.map((t) => TokenResponse.parse(t));
    const tfirst = (tokensRaw[0] ?? {}) as Record<string, unknown>;
    const fp = sha256Hex(
      Object.keys(tfirst)
        .sort()
        .map((k) => `${k}:${tfirst[k] === null ? "null" : typeof tfirst[k]}`)
        .join("|"),
    ).slice(0, 16);
    const decimalsOf = (assetId: string): number | undefined =>
      tokens.find((t) => t.assetId === assetId)?.decimals;
    const attempts: NonNullable<ReplayBundle["oneclick"]>["attempts"] = [];
    for (const spec of o.attempts) {
      const version = Date.parse(spec.fetchedAtUTC);
      if (spec.outcome === "not_attempted") {
        attempts.push({
          spec,
          slot: "unavailable",
          cls: null,
          amountOut: null,
          amountOutFormatted: null,
          rawHash: null,
          version,
        });
        continue;
      }
      let body: Uint8Array | null = null;
      let rawHash: string | null = null;
      if (spec.outcome === "response" && spec.file) {
        body = readFixtureFile(snapshotId, spec.file);
        rawHash = await archiveFile(
          "intents-1click",
          spec.file,
          spec.fetchedAtUTC,
          o.environment,
          ONECLICK_ADAPTER_VERSION,
        );
      }
      const c = classifyQuote({
        status: spec.outcome === "response" ? (spec.status ?? 200) : null,
        body,
        error:
          spec.outcome === "timeout" ? "timeout" : spec.outcome === "network_error" ? "network" : undefined,
        destDecimals: spec.destDecimals ?? decimalsOf(spec.destinationAsset),
      });
      let fmt: string | null = null;
      if (c.class === "OK" && body)
        fmt = (JSON.parse(text(body)) as { quote: { amountOutFormatted: string } }).quote.amountOutFormatted;
      attempts.push({
        spec,
        slot: "observed",
        cls: c.class,
        amountOut: c.amountOutBaseUnits,
        amountOutFormatted: fmt,
        rawHash,
        version,
      });
    }
    bundle.oneclick = {
      label: label(o.environment),
      adapterVersion: ONECLICK_ADAPTER_VERSION,
      attempts,
      schemaFingerprint: fp,
    };
  }

  if (snap.price) {
    const p = snap.price;
    const label_ = label(p.environment);
    const fetches = [];
    for (const f of p.fetches) {
      const hash = await archiveFile(
        "coingecko",
        f.file,
        f.fetchedAtUTC,
        p.environment,
        PRICE_ADAPTER_VERSION,
      );
      fetches.push({
        fileBytes: readFixtureFile(snapshotId, f.file),
        ...(f.volumeFile ? { volumeBytes: readFixtureFile(snapshotId, f.volumeFile) } : {}),
        fetchedAtUTC: f.fetchedAtUTC,
        rawObjectHash: hash,
        sourceLabel: label_,
      });
    }
    const built = buildPriceRows(
      { coinId: p.coinId, symbol: p.symbol, quoteCurrency: p.quoteCurrency, window: p.window },
      fetches,
    );
    bundle.price = {
      label: label_,
      adapterVersion: PRICE_ADAPTER_VERSION,
      rows: built.rows,
      gaps: built.gaps,
      window: p.window,
    };
  }

  if (snap.bigquery) {
    const q = snap.bigquery;
    const out: NonNullable<ReplayBundle["bigquery"]> = {
      label: label(q.environment),
      adapterVersion: BQ_ADAPTER_VERSION,
      dailyUsage: [],
      signerDays: [],
      interactions: [],
    };
    for (const j of q.jobs) {
      const rawHash = await archiveFile(
        "near-bigquery",
        j.file,
        j.fetchedAtUTC,
        q.environment,
        BQ_ADAPTER_VERSION,
      );
      const version = Date.parse(j.fetchedAtUTC);
      const rows = (
        JSON.parse(text(readFixtureFile(snapshotId, j.file))) as { rows: Array<Record<string, string>> }
      ).rows;
      for (const r of rows) {
        if (j.kind === "daily_usage")
          out.dailyUsage.push({
            blockDate: r.block_date as string,
            successfulTxCount: r.tx_count as string,
            functionCallActions: r.function_call_actions as string,
            distinctSignerProxy: r.distinct_signers as string,
            activeContractCount: r.active_contracts as string,
            rawHash,
            version,
          });
        else if (j.kind === "signer_days")
          out.signerDays.push({
            blockDate: r.block_date as string,
            signerAccountId: r.signer_account_id as string,
            rawHash,
            version,
          });
        else
          out.interactions.push({
            blockDate: r.block_date as string,
            receiverAccountId: r.receiver_account_id as string,
            interactions: r.interactions as string,
            rawHash,
            version,
          });
      }
    }
    bundle.bigquery = out;
  }

  const output = normalize(bundle);
  const expectedDigest = manifest.expectedNormalizedDigest ?? null;
  return {
    snapshotId,
    output,
    expectedDigest,
    digestMatches: expectedDigest === null ? null : expectedDigest === output.digest,
    manifestSha256: fixtureHash(snapshotId),
    credentialReads: creds.readCount,
    adapterModes: Object.fromEntries(output.adapters.map((a) => [a.providerId, a.mode])),
  };
}
