import { describe, it, expect } from "vitest";
import { buildDemoTaskA, buildDemoTaskB, buildSmartRoiTask, demoAFaultRules, synthesizeRiskReport, synthesizeHaltedSweep } from "@/lib/agent/tasks";
import { BASE } from "./helpers";
import { parseUsdcToRaw } from "@/lib/format";
import type { PurchaseRecord, RefusalRecord } from "@/lib/agent/buyer";
import { keccak256, stringToHex, type Hex } from "viem";

const usdc = (s: string) => parseUsdcToRaw(s);
const fakeTx = (n: number) => ("0x" + (n + 3).toString(16).padStart(64, "0")) as Hex;

function purchase(url: string, price: bigint): PurchaseRecord {
  return {
    stepIndex: 0,
    endpointUrl: url,
    label: url,
    whatItBought: "data",
    priceRaw: price,
    priceUSDC: "0.10",
    intentId: fakeTx(1),
    txHash: fakeTx(2),
    attempt: 1,
    serverReplay: false,
    quoteCommitment: fakeTx(4),
    settlementCommitment: fakeTx(5),
    data: { riskScore: 42, verdict: "CONDITIONAL_PASS", findings: [], topHolderConcentrationPct: 55.5, liquidityFlow: { netUSDC: 1200 } },
  };
}

function refusal(url: string, code: RefusalRecord["code"]): RefusalRecord {
  return {
    stepIndex: 1,
    endpointUrl: url,
    label: url,
    whatItBought: "data",
    priceRaw: usdc("0.20"),
    priceUSDC: "0.20",
    code,
    message: "test refusal",
  };
}

describe("Requirement 05: Demo task definitions", () => {
  it("Demo A: budget 0.30, cap 0.25, steps audit -> whale", () => {
    const task = buildDemoTaskA(BASE, "t-a");
    expect(task.totalBudgetRaw).toBe(usdc("0.30"));
    expect(task.perCallCapRaw).toBe(usdc("0.25"));
    expect(task.steps.map((s) => s.endpointUrl)).toEqual([
      `${BASE}/api/x402/security-audit`,
      `${BASE}/api/x402/whale-telemetry`,
    ]);
    expect(task.title).toContain("Due-Diligence");
  });

  it("Demo B: budget 0.20, cap 0.18, steps audit -> mev -> whale", () => {
    const task = buildDemoTaskB(BASE, "t-b");
    expect(task.totalBudgetRaw).toBe(usdc("0.20"));
    expect(task.perCallCapRaw).toBe(usdc("0.18"));
    expect(task.steps.map((s) => s.endpointUrl)).toEqual([
      `${BASE}/api/x402/security-audit`,
      `${BASE}/api/x402/mev-simulation`,
      `${BASE}/api/x402/whale-telemetry`,
    ]);
    expect(task.title).toContain("Institutional Alpha Sweep");
  });

  it("Demo A fault rules inject exactly one drop on whale delivery attempt 1", () => {
    const rules = demoAFaultRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({
      endpointMatch: "/api/x402/whale-telemetry",
      phase: "delivery_attempt",
      fromAttempt: 1,
      times: 1,
      type: "drop_connection",
    });
  });

  it("Smart plan excludes the trap and orders by ROI", () => {
    const task = buildSmartRoiTask(BASE, "t-s");
    const urls = task.steps.map((s) => s.endpointUrl);
    expect(urls).not.toContain(`${BASE}/api/x402/institutional-alpha`);
    expect(urls[0]).toBe(`${BASE}/api/x402/whale-telemetry`);
    expect(urls).toHaveLength(3);
    expect(task.totalBudgetRaw).toBe(usdc("0.60"));
  });

  it("generates unique taskRunIds when not provided", () => {
    const a = buildDemoTaskA(BASE);
    const b = buildDemoTaskA(BASE);
    expect(a.taskRunId).not.toBe(b.taskRunId);
    expect(a.taskRunId.startsWith("demo-a-risk-report-")).toBe(true);
  });
});

describe("Demo syntheses", () => {
  it("risk report synthesizes a verdict from audit + whale data", () => {
    const synthesis = synthesizeRiskReport(
      [purchase(`${BASE}/api/x402/security-audit`, usdc("0.10")), purchase(`${BASE}/api/x402/whale-telemetry`, usdc("0.15"))],
      [],
    ) as { verdict: string; signals: string[]; sources: unknown[] };
    expect(synthesis.verdict).toContain("ACCEPTABLE RISK");
    expect(synthesis.signals).toHaveLength(2);
    expect(synthesis.sources).toHaveLength(2);
  });

  it("risk report flags elevated risk on bad inputs", () => {
    const p = purchase(`${BASE}/api/x402/security-audit`, usdc("0.10"));
    (p.data as Record<string, unknown>).riskScore = 85;
    (p.data as Record<string, unknown>).verdict = "NEEDS_REMEDIATION";
    const synthesis = synthesizeRiskReport([p], []) as { verdict: string };
    expect(synthesis.verdict).toContain("ELEVATED RISK");
  });

  it("risk report degrades gracefully with partial data", () => {
    const synthesis = synthesizeRiskReport([purchase(`${BASE}/api/x402/security-audit`, usdc("0.10"))], []) as { verdict: string };
    expect(synthesis.verdict).toContain("PARTIAL DATA");
  });

  it("halted sweep records the refusal audit trail", () => {
    const synthesis = synthesizeHaltedSweep(
      [purchase(`${BASE}/api/x402/security-audit`, usdc("0.10"))],
      [refusal(`${BASE}/api/x402/mev-simulation`, "REFUSED_OVER_PER_CALL_CAP"), refusal(`${BASE}/api/x402/whale-telemetry`, "REFUSED_OVER_TOTAL_BUDGET")],
    ) as { refusalAudit: Array<{ code: string }>; haltReason: string; partialVerdict: string };
    expect(synthesis.refusalAudit).toHaveLength(2);
    expect(synthesis.refusalAudit.map((r) => r.code)).toEqual(["REFUSED_OVER_PER_CALL_CAP", "REFUSED_OVER_TOTAL_BUDGET"]);
    expect(synthesis.haltReason).toContain("BEFORE any signature");
    expect(synthesis.partialVerdict).toContain("risk score 42/100");
  });
});

describe("Default synthesis", () => {
  it("is deterministic for identical inputs", () => {
    const s1 = synthesizeRiskReport([purchase(`${BASE}/x`, usdc("0.10"))], []);
    const s2 = synthesizeRiskReport([purchase(`${BASE}/x`, usdc("0.10"))], []);
    expect((s1 as { digest: string }).digest).toBe((s2 as { digest: string }).digest);
  });
});
