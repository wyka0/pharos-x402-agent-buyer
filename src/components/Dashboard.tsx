"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SerializedTaskResult, SerializedLedgerEntry } from "@/lib/serialize";

interface AppConfig {
  chain: { id: number; networkId: string; name: string; rpcUrl: string; explorerUrl: string; usdc: string };
  endpoints: Array<{ path: string; priceUSDC: string; description: string; trap?: boolean }>;
}

interface WalletStatus {
  configured: boolean;
  buyer?: { address: string; phrs: string; usdc: string };
  payTo?: { address: string; usdc: string | null };
  message?: string;
}

const EVENT_COLORS: Record<string, string> = {
  TASK_STARTED: "text-sky-300",
  TASK_COMPLETED: "text-emerald-300",
  TASK_HALTED: "text-amber-300",
  QUOTE_RECEIVED_402: "text-orange-300",
  PAYMENT_BROADCASTED: "text-emerald-300",
  PAYMENT_RECOVERED_FROM_WAL: "text-fuchsia-300",
  DELIVERY_FAULT_INJECTED: "text-rose-300",
  DELIVERY_RETRYING: "text-yellow-300",
  IDEMPOTENT_REPLAY_ACCEPTED: "text-fuchsia-300",
  REFUSED_OVER_PER_CALL_CAP: "text-rose-300",
  REFUSED_OVER_TOTAL_BUDGET: "text-rose-300",
  REFUSED_LOW_UTILITY: "text-rose-300",
};

function statusBadge(status: string) {
  const map: Record<string, string> = {
    COMPLETED: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    HALTED_BUDGET_EXCEEDED: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    COMPLETED_WITH_PARTIAL_DATA: "bg-sky-500/15 text-sky-300 border-sky-500/40",
    FAILED_NO_PURCHASES: "bg-rose-500/15 text-rose-300 border-rose-500/40",
  };
  return map[status] ?? "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
}

function decisionBadge(e: SerializedLedgerEntry) {
  if (e.debit) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/40";
  switch (e.decision) {
    case "REFUSED_OVER_PER_CALL_CAP":
    case "REFUSED_OVER_TOTAL_BUDGET":
    case "REFUSED_LOW_UTILITY":
    case "FAILED_BROADCAST":
      return "bg-rose-500/15 text-rose-300 border-rose-500/40";
    case "RETRIED_DELIVERED":
      return "bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/40";
    default:
      return "bg-zinc-500/15 text-zinc-300 border-zinc-500/40";
  }
}

function Gauge({ label, value, total, unit }: { label: string; value: string; total: string; unit: string }) {
  const pct = Math.min(100, (parseFloat(value) / Math.max(parseFloat(total), 1e-9)) * 100);
  const color = pct >= 90 ? "bg-rose-400" : pct >= 60 ? "bg-amber-400" : "bg-emerald-400";
  return (
    <div className="rounded-xl border border-[#1c2530] bg-[#0d1117] p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mono mt-1 text-2xl font-semibold text-zinc-100">
        {value} <span className="text-sm text-zinc-500">{unit}</span>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-[11px] text-zinc-600">of {total} {unit} budget</div>
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-[#1c2530] bg-[#0d1117] p-4">
      <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mono mt-1 text-xl font-semibold text-zinc-100">{value}</div>
      {hint ? <div className="mt-1 text-[11px] text-zinc-600">{hint}</div> : null}
    </div>
  );
}

export function Dashboard() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [wallet, setWallet] = useState<WalletStatus | null>(null);
  const [result, setResult] = useState<SerializedTaskResult | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [mode, setMode] = useState<"simulated" | "live">("simulated");
  const [faults, setFaults] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inspectorStep, setInspectorStep] = useState(0);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then(setConfig).catch(() => undefined);
    fetch("/api/wallet").then((r) => r.json()).then(setWallet).catch(() => undefined);
  }, []);

  const runTask = useCallback(
    async (task: "A" | "B" | "SMART") => {
      setRunning(task);
      setError(null);
      setResult(null);
      try {
        const res = await fetch("/api/agent/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task, mode, faults: task === "A" ? faults : false }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);
        setResult(json as SerializedTaskResult);
        setInspectorStep(0);
        fetch("/api/wallet").then((r) => r.json()).then(setWallet).catch(() => undefined);
      } catch (e) {
        setError(String(e));
      } finally {
        setRunning(null);
      }
    },
    [mode, faults],
  );

  const probeEndpoint = useCallback(async (path: string) => {
    setError(null);
    try {
      const res = await fetch(path);
      const header = res.headers.get("payment-required");
      if (header) {
        const decoded = JSON.parse(atob(header));
        alert(
          `HTTP ${res.status} — PAYMENT-REQUIRED decoded:\n\n` +
            `resource: ${decoded.accepts[0].resource}\n` +
            `price: ${Number(decoded.accepts[0].maxAmountRequired) / 1e6} USDC\n` +
            `payTo: ${decoded.accepts[0].payTo}\n` +
            `quoteCommitment: ${decoded.accepts[0].extra.quoteCommitment}\n` +
            `idempotencyKey: ${decoded.accepts[0].extra.idempotencyKey}`,
        );
      } else {
        alert(`HTTP ${res.status} (no PAYMENT-REQUIRED header)`);
      }
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const ledger = result?.ledger ?? [];
  const exchanges = result?.headerLog[inspectorStep]?.exchanges ?? [];
  const lastExchange402 = useMemo(() => {
    const all = result?.headerLog.flatMap((s) => s.exchanges) ?? [];
    return all.find((e) => e.rawPaymentRequiredHeader) ?? null;
  }, [result]);

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      {/* Header */}
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
            x402 Agent Buyer <span className="text-emerald-400">Payment Plane</span>
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">
            Autonomous, budget-gated, ROI-ranked, idempotent x402 buyer on {config?.chain.name ?? "Pharos Atlantic Testnet"}{" "}
            <span className="mono text-zinc-500">(chainId {config?.chain.id ?? 688689})</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="mono rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
            {config?.chain.networkId ?? "eip155:688689"}
          </span>
          <span className="mono rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400">
            USDC {config?.chain.usdc?.slice(0, 10) ?? ""}...
          </span>
        </div>
      </header>

      {/* Wallet status */}
      <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Buyer wallet (server-side)"
          value={wallet?.buyer ? `${wallet.buyer.address.slice(0, 10)}...${wallet.buyer.address.slice(-6)}` : "not configured"}
          hint={wallet?.buyer ? `${wallet.buyer.phrs} PHRS gas · ${wallet.buyer.usdc} USDC` : wallet?.message ?? "simulated mode only"}
        />
        <StatCard label="PayTo (seller)" value={wallet?.payTo ? `${wallet.payTo.address.slice(0, 10)}...${wallet.payTo.address.slice(-6)}` : "—"} hint={wallet?.payTo?.usdc != null ? `holds ${wallet.payTo.usdc} USDC` : undefined} />
        <StatCard label="Settlement mode" value={mode === "live" ? "LIVE on-chain" : "SIMULATED"} hint={mode === "live" ? "real Atlantic USDC EIP-3009 settlements" : "zero-risk: identical protocol, no tokens move"} />
      </section>

      {/* Controls */}
      <section className="mb-8 rounded-2xl border border-[#1c2530] bg-[#0d1117] p-5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => runTask("A")}
            disabled={running !== null}
            className="rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-50 glow-accent"
          >
            {running === "A" ? "Running Demo A..." : "▶ Demo A — Completes (0.30 budget)"}
          </button>
          <button
            onClick={() => runTask("B")}
            disabled={running !== null}
            className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-semibold text-amber-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            {running === "B" ? "Running Demo B..." : "■ Demo B — Budget Halt (0.20 / cap 0.18)"}
          </button>
          <button
            onClick={() => runTask("SMART")}
            disabled={running !== null}
            className="rounded-xl border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-300 transition hover:bg-sky-500/20 disabled:opacity-50"
          >
            {running === "SMART" ? "Planning..." : "◈ Smart ROI Plan (highest gain per USDC)"}
          </button>

          <div className="ml-auto flex items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={faults} onChange={(e) => setFaults(e.target.checked)} className="h-4 w-4 accent-rose-400" />
              Idempotency retry simulator (drop after payment)
            </label>
            <button
              onClick={() => setMode((m) => (m === "simulated" ? "live" : "simulated"))}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                mode === "live"
                  ? "border-rose-500/50 bg-rose-500/10 text-rose-300"
                  : "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              }`}
            >
              {mode === "live" ? "● LIVE settlements — click to switch to simulated" : "○ Simulated — click to arm LIVE"}
            </button>
          </div>
        </div>

        {mode === "live" ? (
          <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">
            LIVE mode signs and broadcasts real USDC settlements on Pharos Atlantic from the server wallet. Demo A spends
            0.25 USDC; Demo B spends 0.10 USDC.
          </p>
        ) : null}

        {error ? <p className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">{error}</p> : null}
      </section>

      {/* Result */}
      {result ? (
        <>
          <section className="mb-8">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-zinc-100">
                {result.title}{" "}
                <span className={`mono ml-2 rounded-md border px-2 py-0.5 text-xs ${statusBadge(result.status)}`}>{result.status}</span>
              </h2>
              <div className="mono text-xs text-zinc-500">
                taskRunId {result.taskRunId} · broadcasts {result.broadcasts.attempted}
                {result.broadcasts.skippedViaJournal > 0 ? ` (+${result.broadcasts.skippedViaJournal} reused from WAL)` : ""} · faults{" "}
                {result.faultsInjected} · {result.mode}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Gauge label="Running spend" value={result.gauges.runningTotalUSDC} total={result.gauges.totalBudgetUSDC} unit="USDC" />
              <Gauge label="Remaining budget" value={result.gauges.remainingBudgetUSDC} total={result.gauges.totalBudgetUSDC} unit="USDC" />
              <StatCard label="Per-call cap" value={`${result.gauges.perCallCapUSDC} USDC`} hint="hard refusal above this price per call" />
              <StatCard label="Committed / reserved" value={`${result.gauges.committedSpendUSDC} / ${result.gauges.reservedSpendUSDC}`} hint="atomic reservation locks" />
            </div>
          </section>

          {/* Ledger */}
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold text-zinc-100">Payment Ledger</h2>
            <div className="overflow-x-auto rounded-2xl border border-[#1c2530]">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-[#101722] text-xs uppercase tracking-wider text-zinc-500">
                  <tr>
                    <th className="px-3 py-2.5">#</th>
                    <th className="px-3 py-2.5">Step</th>
                    <th className="px-3 py-2.5">Endpoint</th>
                    <th className="px-3 py-2.5">What it bought</th>
                    <th className="px-3 py-2.5">Price</th>
                    <th className="px-3 py-2.5">Decision</th>
                    <th className="px-3 py-2.5">Tx (PharosScan)</th>
                    <th className="px-3 py-2.5">Block</th>
                    <th className="px-3 py-2.5">Running</th>
                    <th className="px-3 py-2.5">Remaining</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#161f2c]">
                  {ledger.map((e) => (
                    <tr key={e.seq} className="hover:bg-[#101722]/60">
                      <td className="mono px-3 py-2.5 text-zinc-500">{e.seq}</td>
                      <td className="mono px-3 py-2.5 text-zinc-400">{e.stepIndex + 1}</td>
                      <td className="mono px-3 py-2.5 text-zinc-300">{e.endpointLabel}</td>
                      <td className="max-w-[260px] px-3 py-2.5 text-xs text-zinc-500">{e.whatItBought}</td>
                      <td className="mono px-3 py-2.5 text-zinc-200">{e.priceUSDC}</td>
                      <td className="px-3 py-2.5">
                        <span className={`mono rounded-md border px-2 py-0.5 text-[11px] ${decisionBadge(e)}`}>{e.decision}</span>
                      </td>
                      <td className="mono px-3 py-2.5 text-xs">
                        {e.explorerUrl ? (
                          <a href={e.explorerUrl} target="_blank" rel="noreferrer" className="text-emerald-300 underline decoration-emerald-500/40 hover:text-emerald-200">
                            {e.txHash?.slice(0, 14)}...
                          </a>
                        ) : (
                          <span className="text-zinc-600">—</span>
                        )}
                      </td>
                      <td className="mono px-3 py-2.5 text-zinc-400">{e.blockNumber ?? "—"}</td>
                      <td className="mono px-3 py-2.5 text-zinc-100">{e.runningTotalUSDC}</td>
                      <td className="mono px-3 py-2.5 text-zinc-400">{e.remainingBudgetUSDC}</td>
                    </tr>
                  ))}
                  {ledger.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-6 text-center text-zinc-600">
                        No entries yet — run a demo.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          {/* 402 inspector */}
          <section className="mb-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-[#1c2530] bg-[#0d1117] p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">402 Negotiation Inspector — challenge</h2>
              <select
                value={inspectorStep}
                onChange={(e) => setInspectorStep(Number(e.target.value))}
                className="mono mb-3 w-full rounded-lg border border-[#1c2530] bg-[#0a0e14] px-2 py-1.5 text-xs text-zinc-300"
              >
                {result.headerLog.map((s) => (
                  <option key={s.stepIndex} value={s.stepIndex}>
                    step {s.stepIndex + 1} — {s.label}
                  </option>
                ))}
              </select>
              <pre className="mono max-h-72 overflow-auto rounded-lg bg-[#0a0e14] p-3 text-[11px] leading-relaxed text-zinc-400">
                {lastExchange402?.rawPaymentRequiredHeader
                  ? JSON.stringify(JSON.parse(atob(lastExchange402.rawPaymentRequiredHeader)), null, 2)
                  : "No 402 captured."}
              </pre>
              {lastExchange402 ? (
                <p className="mono mt-2 text-[10px] text-zinc-600">
                  verbatim header ({lastExchange402.rawPaymentRequiredHeader?.length ?? 0} b64 chars):{" "}
                  {lastExchange402.rawPaymentRequiredHeader?.slice(0, 72)}...
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-[#1c2530] bg-[#0d1117] p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-zinc-400">PAYMENT-RESPONSE (delivery proof)</h2>
              <pre className="mono max-h-72 overflow-auto rounded-lg bg-[#0a0e14] p-3 text-[11px] leading-relaxed text-zinc-400">
                {(() => {
                  const withResp = exchanges.find((e) => e.rawPaymentResponseHeader);
                  if (!withResp?.rawPaymentResponseHeader) return "No PAYMENT-RESPONSE captured.";
                  return JSON.stringify(JSON.parse(atob(withResp.rawPaymentResponseHeader)), null, 2);
                })()}
              </pre>
            </div>
          </section>

          {/* Transcript */}
          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold text-zinc-100">Agent Transcript</h2>
            <div className="mono max-h-96 overflow-auto rounded-2xl border border-[#1c2530] bg-[#0a0e14] p-4 text-xs leading-relaxed">
              {result.events.map((ev) => (
                <div key={ev.seq} className="flex gap-3 py-0.5">
                  <span className="text-zinc-600">{ev.at.slice(11, 23)}</span>
                  <span className={`w-56 shrink-0 ${EVENT_COLORS[ev.type] ?? "text-zinc-400"}`}>{ev.type}</span>
                  <span className="text-zinc-300">{ev.message}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Synthesis */}
          <section className="mb-8 rounded-2xl border border-[#1c2530] bg-[#0d1117] p-5">
            <h2 className="mb-3 text-lg font-semibold text-zinc-100">Synthesis</h2>
            <pre className="mono max-h-72 overflow-auto rounded-lg bg-[#0a0e14] p-3 text-[11px] leading-relaxed text-zinc-300">
              {JSON.stringify(result.synthesis, null, 2)}
            </pre>
          </section>
        </>
      ) : null}

      {/* Endpoint catalog + probes */}
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">Paywalled Endpoint Catalog (self-hosted x402 providers)</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {(config?.endpoints ?? []).map((ep) => (
            <div key={ep.path} className={`rounded-xl border p-4 ${ep.trap ? "border-rose-500/30 bg-rose-500/5" : "border-[#1c2530] bg-[#0d1117]"}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="mono text-sm text-zinc-200">{ep.path}</span>
                <span className={`mono rounded-md border px-2 py-0.5 text-xs ${ep.trap ? "border-rose-500/40 text-rose-300" : "border-emerald-500/40 text-emerald-300"}`}>
                  {ep.priceUSDC} USDC
                </span>
              </div>
              <p className="mt-2 text-xs text-zinc-500">{ep.description}</p>
              <button onClick={() => probeEndpoint(ep.path)} className="mono mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-300 transition hover:bg-zinc-800">
                Probe (dry 402 fetch — free)
              </button>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-[#1c2530] pt-6 text-xs text-zinc-600">
        x402 Agent Buyer · Pharos Atlantic Testnet · quote-to-settlement keccak commitments · WAL-backed idempotent retries ·
        atomic budget reservations · ROI-ranked purchasing
      </footer>
    </main>
  );
}
