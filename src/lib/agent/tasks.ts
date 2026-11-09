/**
 * Requirement 05 — two built-in end-to-end demo tasks + the ROI smart plan.
 *
 * Demo A: "DeFi Token Risk Due-Diligence Report" — budget 0.30, cap 0.25.
 *   security-audit (0.10) pays; whale-telemetry (0.15) suffers a simulated
 *   delivery drop AFTER payment and recovers idempotently (zero double-charge).
 *   Finishes COMPLETED at 0.25 / 0.30 USDC.
 *
 * Demo B: "Full Deep-Dive + MEV + Institutional Alpha Sweep" — budget 0.20, cap 0.18.
 *   security-audit (0.10) pays; mev-simulation (0.20) refused by per-call cap
 *   (0.20 > 0.18); whale-telemetry (0.15) refused by total budget
 *   (0.10 + 0.15 = 0.25 > 0.20). Halts gracefully with a refusal audit trail.
 */
import type { AgentTask, PurchaseRecord, RefusalRecord, TaskStep } from "./buyer";
import { AGENT_VALUE_CATALOG } from "../server/catalog";
import { scoreRoi, type CatalogEntry } from "../roi";
import { formatUsdc } from "../format";

export const DEMO_A = {
  taskRunIdPrefix: "demo-a-risk-report",
  title: "Execute DeFi Token Risk Due-Diligence Report",
  description:
    "Buy security audit telemetry and whale concentration/flow analytics under a 0.30 USDC budget with a 0.25 USDC per-call cap, then synthesize a risk report.",
  budgetRaw: 300_000n,
  capRaw: 250_000n,
  steps: ["/api/x402/security-audit", "/api/x402/whale-telemetry"] as const,
};

export const DEMO_B = {
  taskRunIdPrefix: "demo-b-deep-dive",
  title: "Full Deep-Dive + MEV + Institutional Alpha Sweep",
  description:
    "Ambitious sweep under a 0.20 USDC budget with a 0.18 USDC per-call cap: audit, MEV simulation, and whale telemetry — expected to halt on budget/cap limits.",
  budgetRaw: 200_000n,
  capRaw: 180_000n,
  steps: ["/api/x402/security-audit", "/api/x402/mev-simulation", "/api/x402/whale-telemetry"] as const,
};

/** Demo A fault: whale-telemetry delivery drops once, after the payment broadcast. */
export function demoAFaultRules() {
  return [
    {
      endpointMatch: "/api/x402/whale-telemetry",
      phase: "delivery_attempt" as const,
      fromAttempt: 1,
      times: 1,
      type: "drop_connection" as const,
    },
  ];
}

function toSteps(baseUrl: string, paths: readonly string[]): TaskStep[] {
  return paths.map((p) => ({ endpointUrl: p.startsWith("http") ? p : `${baseUrl.replace(/\/$/, "")}${p}` }));
}

let taskRunCounter = 0;
function freshTaskRunId(prefix: string): string {
  taskRunCounter += 1;
  return `${prefix}-${Date.now()}-${taskRunCounter}`;
}

export function buildDemoTaskA(baseUrl: string, taskRunId?: string): AgentTask {
  return {
    taskRunId: taskRunId ?? freshTaskRunId(DEMO_A.taskRunIdPrefix),
    title: DEMO_A.title,
    description: DEMO_A.description,
    totalBudgetRaw: DEMO_A.budgetRaw,
    perCallCapRaw: DEMO_A.capRaw,
    baseUrl,
    steps: toSteps(baseUrl, DEMO_A.steps),
    synthesis: synthesizeRiskReport,
  };
}

export function buildDemoTaskB(baseUrl: string, taskRunId?: string): AgentTask {
  return {
    taskRunId: taskRunId ?? freshTaskRunId(DEMO_B.taskRunIdPrefix),
    title: DEMO_B.title,
    description: DEMO_B.description,
    totalBudgetRaw: DEMO_B.budgetRaw,
    perCallCapRaw: DEMO_B.capRaw,
    baseUrl,
    steps: toSteps(baseUrl, DEMO_B.steps),
    synthesis: synthesizeHaltedSweep,
  };
}

/**
 * Innovation #2 showcase: the full catalog scored by information-gain per USDC,
 * ordered highest-ROI first, with the over-cap trap excluded by the utility gate.
 */
export function buildSmartRoiTask(baseUrl: string, taskRunId?: string): AgentTask {
  const budgetRaw = 600_000n;
  const capRaw = 250_000n;
  const candidates = (Object.keys(AGENT_VALUE_CATALOG) as Array<keyof typeof AGENT_VALUE_CATALOG>).filter(
    (p) => p !== "/api/x402/institutional-alpha",
  );
  const scored = candidates
    .map((path) => {
      const entry = AGENT_VALUE_CATALOG[path] as CatalogEntry;
      const url = `${baseUrl.replace(/\/$/, "")}${path}`;
      const priceRaw = path === "/api/x402/security-audit" ? 100_000n : path === "/api/x402/whale-telemetry" ? 150_000n : 200_000n;
      return { path, url, priceRaw, score: scoreRoi(entry, priceRaw) };
    })
    .sort((a, b) => b.score.roi - a.score.roi || (AGENT_VALUE_CATALOG[b.path].expectedSignals - AGENT_VALUE_CATALOG[a.path].expectedSignals));
  const steps: TaskStep[] = scored.map((s) => ({ endpointUrl: s.url, label: AGENT_VALUE_CATALOG[s.path].label }));
  return {
    taskRunId: taskRunId ?? freshTaskRunId("smart-roi"),
    title: "Smart ROI Sweep (highest information-gain per USDC first)",
    description: `Auto-planned by the ROI scorer: ${scored.map((s) => `${s.path} (ROI ${s.score.roi.toFixed(2)}x)`).join(" -> ")}. Budget 0.60 USDC, cap 0.25 USDC.`,
    totalBudgetRaw: budgetRaw,
    perCallCapRaw: capRaw,
    baseUrl,
    steps,
    synthesis: synthesizeRiskReport,
  };
}

// --- Synthesis -------------------------------------------------------------------

export function synthesizeRiskReport(purchases: PurchaseRecord[], refusals: RefusalRecord[]): Record<string, unknown> {
  const audit = purchases.find((p) => p.endpointUrl.includes("security-audit"))?.data as
    | { riskScore?: number; verdict?: string; findings?: Array<{ severity: string; title: string; swcId: string }> }
    | undefined;
  const whale = purchases.find((p) => p.endpointUrl.includes("whale-telemetry"))?.data as
    | { topHolderConcentrationPct?: number; liquidityFlow?: { netUSDC?: number }; whaleAlerts?: unknown[] }
    | undefined;

  const riskScore = audit?.riskScore ?? null;
  const concentration = whale?.topHolderConcentrationPct ?? null;
  const netFlow = whale?.liquidityFlow?.netUSDC ?? null;

  const signals: string[] = [];
  if (riskScore !== null) {
    signals.push(`Contract risk score ${riskScore}/100 (${audit?.verdict}) with ${(audit?.findings ?? []).length} SWC-classified findings.`);
  }
  if (concentration !== null) {
    signals.push(`Top-10 holder concentration ${concentration}% with net liquidity flow ${netFlow} USDC over the window.`);
  }

  const elevated = (riskScore ?? 0) > 70 || (concentration ?? 0) > 60;
  const complete = riskScore !== null && concentration !== null;
  const anyData = riskScore !== null || concentration !== null;
  const verdict = !anyData
    ? "PARTIAL DATA — verdict degraded due to missing paid signals."
    : elevated
      ? "ELEVATED RISK — position sizing should be reduced."
      : complete
        ? "ACCEPTABLE RISK — proceed with standard position sizing."
        : "PARTIAL DATA — verdict degraded due to missing paid signals.";

  return {
    report: "DeFi Token Risk Due-Diligence Report",
    verdict,
    signals,
    sources: purchases.map((p) => ({ endpoint: p.label, txHash: p.txHash, priceUSDC: p.priceUSDC })),
    refusedCalls: refusals.map((r) => ({ endpoint: r.label, code: r.code, reason: r.message })),
    methodology: "x402 pay-per-signal: security-audit + whale-telemetry, ROI-ranked and budget-gated on Pharos Atlantic.",
  };
}

export function synthesizeHaltedSweep(purchases: PurchaseRecord[], refusals: RefusalRecord[]): Record<string, unknown> {
  const audit = purchases.find((p) => p.endpointUrl.includes("security-audit"))?.data as
    | { riskScore?: number; verdict?: string }
    | undefined;
  return {
    report: "Full Deep-Dive Sweep (halted)",
    partialVerdict:
      audit?.riskScore !== undefined
        ? `Partial synthesis from the paid audit: risk score ${audit.riskScore}/100 (${audit.verdict}). MEV and whale layers were NOT purchased.`
        : "No data purchased — every call was refused before signing.",
    purchasedSignals: purchases.map((p) => ({ endpoint: p.label, data: p.data })),
    refusalAudit: refusals.map((r) => ({
      endpoint: r.label,
      code: r.code,
      priceUSDC: r.priceUSDC,
      reason: r.message,
    })),
    haltReason:
      "Per-call cap and total-budget gates refused the remaining calls BEFORE any signature; the agent halted gracefully instead of over-spending.",
  };
}

export function formatBudgetHint(totalBudgetRaw: bigint, perCallCapRaw: bigint): string {
  return `budget=${formatUsdc(totalBudgetRaw)} USDC cap=${formatUsdc(perCallCapRaw)} USDC`;
}
