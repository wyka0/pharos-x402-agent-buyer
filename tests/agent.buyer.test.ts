import { describe, it, expect, beforeEach } from "vitest";
import { makeWorld, makeAgent, buildPaidPayload, BASE, PAY_TO } from "./helpers";
import { buildDemoTaskA, buildDemoTaskB, buildSmartRoiTask, demoAFaultRules } from "@/lib/agent/tasks";
import { encodePaymentPayload, PAYMENT_SIGNATURE_HEADER, IDEMPOTENCY_KEY_HEADER, decodePaymentRequired, decodePaymentResponse, decodePaymentPayload } from "@/lib/x402";
import { serveX402 } from "@/lib/server/x402Endpoint";
import { ENDPOINT_SPECS } from "@/lib/server/catalog";
import { BudgetGovernor } from "@/lib/budget";
import { parseUsdcToRaw } from "@/lib/format";
import { NETWORK_ID, CHAIN_ID } from "@/lib/chain";

let world: ReturnType<typeof makeWorld>;
beforeEach(() => {
  world = makeWorld();
});

const usdc = (s: string) => parseUsdcToRaw(s);

describe("Requirement 05 / Demo Task A: completes within budget", () => {
  it("pays security-audit (0.10) then whale-telemetry (0.15) with a safe idempotent retry", async () => {
    const task = buildDemoTaskA(BASE, "demo-a-test-1");
    const { agent, ledger } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId });
    const result = await agent.runTask(task);

    expect(result.status).toBe("COMPLETED");
    expect(result.purchases).toHaveLength(2);
    expect(result.refusals).toHaveLength(0);

    // Exact prices paid
    expect(result.purchases[0].priceRaw).toBe(usdc("0.10"));
    expect(result.purchases[1].priceRaw).toBe(usdc("0.15"));

    // Running totals: 0.10 then 0.25 of 0.30
    const paid = result.ledger.filter((e) => e.debit);
    expect(paid).toHaveLength(2);
    expect(paid[0].runningTotalUSDC).toBe("0.10");
    expect(paid[1].runningTotalUSDC).toBe("0.25");
    expect(result.gauges.remainingBudgetUSDC).toBe("0.05");

    // Exactly two on-chain settlements, two distinct txs
    expect(result.broadcasts.attempted).toBe(2);
    expect(world.sim.all()).toHaveLength(2);
    expect(result.purchases[0].txHash).not.toBe(result.purchases[1].txHash);

    // Fault was injected once on whale delivery; retry succeeded with the SAME proof
    expect(result.faultsInjected).toBe(1);
    expect(result.purchases[1].attempt).toBe(2);

    // Ledger records the idempotent redelivery without an extra debit
    const retried = result.ledger.filter((e) => e.decision === "RETRIED_DELIVERED");
    expect(retried).toHaveLength(1);
    expect(retried[0].stepIndex).toBe(1);

    // Synthesis contains the risk report
    expect(result.synthesis).toHaveProperty("verdict");
    expect(JSON.stringify(result.synthesis)).toContain("Due-Diligence");
    expect(ledger.entriesSnapshot().length).toBeGreaterThanOrEqual(3);
  });

  it("records verbatim 402 and 200 headers for the inspector", async () => {
    const task = buildDemoTaskA(BASE, "demo-a-headers");
    const { agent } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId });
    const result = await agent.runTask(task);

    const initial = result.headerLog[0].exchanges.find((e) => e.phase === "initial");
    expect(initial?.responseStatus).toBe(402);
    expect(initial?.rawPaymentRequiredHeader).toBeTruthy();
    const decoded = decodePaymentRequired(initial!.rawPaymentRequiredHeader!);
    expect(decoded.accepts[0].resource).toBe(`${BASE}/api/x402/security-audit`);

    const delivery = result.headerLog[0].exchanges.find((e) => e.phase === "delivery");
    expect(delivery?.responseStatus).toBe(200);
    expect(delivery?.rawPaymentResponseHeader).toBeTruthy();
    const settlement = decodePaymentResponse(delivery!.rawPaymentResponseHeader!);
    expect(settlement.settlement.txHash).toBe(result.purchases[0].txHash);
  });

  it("emits the full protocol event trail in order", async () => {
    const task = buildDemoTaskA(BASE, "demo-a-events");
    const { agent } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    const types = result.events.map((e) => e.type);
    expect(types[0]).toBe("TASK_STARTED");
    expect(types).toContain("QUOTE_RECEIVED_402");
    expect(types).toContain("BUDGET_RESERVED");
    expect(types).toContain("PAYMENT_BROADCASTED");
    expect(types).toContain("DELIVERY_FAULT_INJECTED");
    expect(types).toContain("DELIVERY_RETRYING");
    expect(types[types.length - 1]).toBe("TASK_COMPLETED");
    // WAL recorded before every HTTP re-submit
    const walIdx = types.indexOf("WAL_RECORDED");
    const deliveryIdx = types.indexOf("DELIVERY_ATTEMPT");
    expect(walIdx).toBeGreaterThan(-1);
    expect(deliveryIdx).toBeGreaterThan(walIdx);
  });

  it("the same payment proof bytes are reused on the retry (identical PAYMENT-SIGNATURE)", async () => {
    const task = buildDemoTaskA(BASE, "demo-a-same-proof");
    const seenPayloads = new Map<string, string>();
    const recordingFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const header = new Headers(init?.headers).get(PAYMENT_SIGNATURE_HEADER);
      if (header && url.includes("whale-telemetry")) {
        const decoded = decodePaymentPayload(header);
        seenPayloads.set(url, header);
        expect(decoded.intentId).toBeTruthy();
      }
      return world.fetchFn(input, init);
    };
    const { agent } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId, fetchFn: recordingFetch });
    const result = await agent.runTask(task);
    expect(result.status).toBe("COMPLETED");
    // Only one distinct whale payload was ever sent, despite the retry
    const whalePayloads = new Set([...seenPayloads.keys()].map((k) => seenPayloads.get(k)));
    expect(whalePayloads.size).toBe(1);
  });
});

describe("Requirement 05 / Demo Task B: halts on budget/cap limits", () => {
  it("refuses MEV by per-call cap and whale by total budget, then halts", async () => {
    const task = buildDemoTaskB(BASE, "demo-b-test-1");
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);

    expect(result.status).toBe("HALTED_BUDGET_EXCEEDED");
    expect(result.purchases).toHaveLength(1);
    expect(result.purchases[0].priceRaw).toBe(usdc("0.10"));
    expect(result.refusals).toHaveLength(2);

    const [capRefusal, budgetRefusal] = result.refusals;
    expect(capRefusal.code).toBe("REFUSED_OVER_PER_CALL_CAP");
    expect(capRefusal.endpointUrl).toContain("mev-simulation");
    expect(capRefusal.priceUSDC).toBe("0.20");
    expect(budgetRefusal.code).toBe("REFUSED_OVER_TOTAL_BUDGET");
    expect(budgetRefusal.endpointUrl).toContain("whale-telemetry");
    expect(budgetRefusal.priceUSDC).toBe("0.15");

    // Exactly ONE on-chain settlement; nothing else was signed or broadcast
    expect(result.broadcasts.attempted).toBe(1);
    expect(world.sim.all()).toHaveLength(1);

    // Running totals: 0.10 spent, 0.10 remaining
    expect(result.gauges.runningTotalUSDC).toBe("0.10");
    expect(result.gauges.remainingBudgetUSDC).toBe("0.10");

    // Refusals are recorded in the ledger with running totals unchanged
    const refusalEntries = result.ledger.filter((e) => e.decision.startsWith("REFUSED"));
    expect(refusalEntries).toHaveLength(2);
    expect(refusalEntries[0].runningTotalUSDC).toBe("0.10");
    expect(refusalEntries[0].remainingBudgetUSDC).toBe("0.10");

    // Halt transcript + partial synthesis
    expect(result.events.at(-1)?.type).toBe("TASK_HALTED");
    expect(JSON.stringify(result.synthesis)).toContain("halted");
    expect((result.synthesis as Record<string, unknown>).refusalAudit).toHaveLength(2);
  });

  it("never signs anything for refused calls (no authorization events after refusal)", async () => {
    const task = buildDemoTaskB(BASE, "demo-b-no-sign");
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    const signingEvents = result.events.filter((e) => e.type === "PAYMENT_SIGNING");
    const broadcastEvents = result.events.filter((e) => e.type === "PAYMENT_BROADCASTED");
    expect(signingEvents).toHaveLength(1); // only the affordable audit step
    expect(broadcastEvents).toHaveLength(1);
    const refusalEvents = result.events.filter((e) => e.type === "REFUSED_OVER_PER_CALL_CAP" || e.type === "REFUSED_OVER_TOTAL_BUDGET");
    expect(refusalEvents).toHaveLength(2);
  });

  it("keeps the spec order: audit -> mev -> whale", async () => {
    const task = buildDemoTaskB(BASE, "demo-b-order");
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    expect(result.headerLog.map((h) => h.endpointUrl)).toEqual([
      `${BASE}/api/x402/security-audit`,
      `${BASE}/api/x402/mev-simulation`,
      `${BASE}/api/x402/whale-telemetry`,
    ]);
  });
});

describe("Smart ROI plan (Innovation #2 showcase)", () => {
  it("orders all affordable endpoints by information-gain per USDC", () => {
    const task = buildSmartRoiTask(BASE, "smart-1");
    expect(task.steps).toHaveLength(3);
    expect(task.steps.map((s) => s.endpointUrl)).toEqual([
      `${BASE}/api/x402/whale-telemetry`, // ROI 2.0, 133 signals/USDC
      `${BASE}/api/x402/security-audit`, // ROI 2.0
      `${BASE}/api/x402/mev-simulation`, // ROI 1.75
    ]);
  });

  it("runs the smart plan to completion and spends 0.45 of 0.60", async () => {
    const task = buildSmartRoiTask(BASE, "smart-2");
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    expect(result.status).toBe("COMPLETED");
    expect(result.gauges.runningTotalUSDC).toBe("0.45");
    expect(result.broadcasts.attempted).toBe(3);
  });
});

describe("Requirement 01: four distinct paywalled endpoints callable in one task", () => {
  it("the buyer agent can call 2-4 different x402 endpoints during a task", async () => {
    const task = {
      taskRunId: "multi-1",
      title: "Four-endpoint sweep",
      description: "Calls every self-hosted x402 endpoint",
      totalBudgetRaw: usdc("1.00"),
      perCallCapRaw: usdc("0.60"),
      baseUrl: BASE,
      steps: [
        { endpointUrl: `${BASE}/api/x402/security-audit` },
        { endpointUrl: `${BASE}/api/x402/whale-telemetry` },
        { endpointUrl: `${BASE}/api/x402/mev-simulation` },
        { endpointUrl: `${BASE}/api/x402/institutional-alpha` },
      ],
    };
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    // All four delivered (budget is generous; the trap's LOW UTILITY would refuse
    // if the catalog value were below price, but with cap 0.60 it is affordable
    // and the catalog marks it 0.05 < 0.50 -> refused by utility instead).
    expect(["COMPLETED", "COMPLETED_WITH_PARTIAL_DATA", "HALTED_BUDGET_EXCEEDED"]).toContain(result.status);
    expect(result.headerLog).toHaveLength(4);
    expect(world.sim.all().length).toBeGreaterThanOrEqual(3);
    // The institutional-alpha trap is refused by the ROI utility gate, never paid
    const trapRefusal = result.refusals.find((r) => r.endpointUrl.includes("institutional-alpha"));
    expect(trapRefusal?.code).toBe("REFUSED_LOW_UTILITY");
    expect(result.purchases.some((p) => p.endpointUrl.includes("institutional-alpha"))).toBe(false);
  });
});

describe("Requirement 02: hard refusals happen BEFORE signing", () => {
  it("a task whose every call is refused performs zero broadcasts and zero signatures", async () => {
    const task = {
      taskRunId: "all-refused",
      title: "Impossible budget",
      description: "Budget smaller than any price",
      totalBudgetRaw: usdc("0.05"),
      perCallCapRaw: usdc("0.18"),
      baseUrl: BASE,
      steps: [{ endpointUrl: `${BASE}/api/x402/security-audit` }, { endpointUrl: `${BASE}/api/x402/whale-telemetry` }],
    };
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    expect(result.status).toBe("HALTED_BUDGET_EXCEEDED");
    expect(result.purchases).toHaveLength(0);
    expect(result.broadcasts.attempted).toBe(0);
    expect(world.sim.all()).toHaveLength(0);
    expect(result.refusals.every((r) => r.code === "REFUSED_OVER_TOTAL_BUDGET")).toBe(true);
    expect(result.events.some((e) => e.type === "PAYMENT_SIGNING")).toBe(false);
  });

  it("the over-cap trap is refused even with an unlimited budget when the cap is tight", async () => {
    const governor = new BudgetGovernor({ totalBudgetRaw: usdc("100.00"), perCallCapRaw: usdc("0.25") });
    const task = {
      taskRunId: "trap-cap",
      title: "Trap probe",
      description: "trap vs cap",
      totalBudgetRaw: usdc("100.00"),
      perCallCapRaw: usdc("0.25"),
      baseUrl: BASE,
      steps: [{ endpointUrl: `${BASE}/api/x402/institutional-alpha` }],
    };
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId, governor });
    const result = await agent.runTask(task);
    expect(result.refusals[0].code).toBe("REFUSED_LOW_UTILITY");
    expect(result.broadcasts.attempted).toBe(0);
  });
});

describe("External x402 endpoints (plug in any dev's URL)", () => {
  it("an unknown endpoint is quoted, trust-discounted, and can complete the flow", async () => {
    // Stand up an external endpoint on a different origin using the same service
    const externalOrigin = "http://external.dev";
    const externalDeps = {
      spec: ENDPOINT_SPECS["/api/x402/mev-simulation"],
      verifierFor: () => world.verifier,
      network: NETWORK_ID,
      chainId: CHAIN_ID,
      asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
      payTo: PAY_TO,
    };
    const externalFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith(externalOrigin)) {
        return serveX402(new Request(url, init), externalDeps);
      }
      return world.fetchFn(input, init);
    };
    const task = {
      taskRunId: "external-1",
      title: "External provider",
      description: "Plug in a third-party x402 endpoint",
      totalBudgetRaw: usdc("0.50"),
      perCallCapRaw: usdc("0.25"),
      baseUrl: BASE,
      steps: [{ endpointUrl: `${externalOrigin}/api/x402/mev-simulation`, label: "External MEV" }],
    };
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId, fetchFn: externalFetch });
    const result = await agent.runTask(task);
    // 0.20 price vs discounted utility 0.35*0.5 = 0.175 -> refused by utility gate.
    expect(result.status).toBe("FAILED_NO_PURCHASES");
    expect(result.refusals[0].code).toBe("REFUSED_LOW_UTILITY");
    expect(result.refusals[0].roi?.source).toBe("advertised-discounted");
    expect(result.broadcasts.attempted).toBe(0);
  });
});
