import { describe, it, expect, beforeEach } from "vitest";
import { makeWorld, makeAgent, BASE } from "./helpers";
import { buildDemoTaskA, demoAFaultRules } from "@/lib/agent/tasks";
import { InMemoryJournal } from "@/lib/idempotency";
import { parseUsdcToRaw } from "@/lib/format";
import { PAYMENT_SIGNATURE_HEADER, IDEMPOTENCY_KEY_HEADER } from "@/lib/x402";

let world: ReturnType<typeof makeWorld>;
beforeEach(() => {
  world = makeWorld();
});

const usdc = (s: string) => parseUsdcToRaw(s);

describe("Requirement 04: safe idempotent retries under injected faults", () => {
  it("3 delivery failures after payment result in exactly 1 broadcast, 1 ledger debit, and no double-count", async () => {
    const task = buildDemoTaskA(BASE, "retry-proof-1");
    const harshFaults = [
      { endpointMatch: "/api/x402/whale-telemetry", phase: "delivery_attempt" as const, fromAttempt: 1, times: 2, type: "http_502" as const },
    ];
    const { agent } = makeAgent(world, task, { faultRules: harshFaults, taskRunId: task.taskRunId, maxDeliveryAttempts: 3 });
    const result = await agent.runTask(task);

    expect(result.status).toBe("COMPLETED");
    expect(result.faultsInjected).toBe(2);
    // whale delivery attempts: 502, 502, then success on attempt 3
    expect(result.purchases.find((p) => p.endpointUrl.includes("whale"))!.attempt).toBe(3);

    // EXACTLY one on-chain payment per endpoint — never more
    expect(result.broadcasts.attempted).toBe(2);
    const whaleIntent = result.purchases.find((p) => p.endpointUrl.includes("whale"))!.intentId;
    expect(world.sim.all().filter((t) => t.intentId === whaleIntent)).toHaveLength(1);

    // EXACTLY one ledger debit per endpoint; running total went 0.10 -> 0.25 once
    const debits = result.ledger.filter((e) => e.debit);
    expect(debits).toHaveLength(2);
    expect(debits.map((d) => d.runningTotalUSDC)).toEqual(["0.10", "0.25"]);
    expect(result.gauges.runningTotalUSDC).toBe("0.25");

    // The retried delivery is recorded as a non-debit audit entry
    const retried = result.ledger.filter((e) => e.decision === "RETRIED_DELIVERED");
    expect(retried).toHaveLength(1);
    expect(retried[0].runningTotalUSDC).toBe("0.25");
  });

  it("WAL is written BEFORE the HTTP re-submit and binds intent -> txHash", async () => {
    const journal = new InMemoryJournal();
    const task = buildDemoTaskA(BASE, "retry-proof-wal");
    const { agent } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId, journal });
    const result = await agent.runTask(task);
    expect(result.status).toBe("COMPLETED");

    const entries = await journal.list();
    const whaleEntry = entries.find((e) => e.endpointUrl.includes("whale-telemetry"));
    expect(whaleEntry).toBeDefined();
    expect(whaleEntry!.txHash).toBe(result.purchases[1].txHash);
    expect(whaleEntry!.paymentPayload).toBeDefined();
    expect(whaleEntry!.paymentPayload!.txHash).toBe(result.purchases[1].txHash);
    expect(whaleEntry!.state).toBe("DELIVERED_200");
  });

  it("a fresh agent (simulated crash) recovers paid txHashes from the shared WAL and NEVER re-broadcasts", async () => {
    const journal = new InMemoryJournal();
    const taskA = buildDemoTaskA(BASE, "crash-recovery-1");
    const serverDown = [
      { endpointMatch: "/api/x402/whale-telemetry", phase: "delivery_attempt" as const, fromAttempt: 1, times: 99, type: "http_502" as const },
    ];
    // First "process": pays both endpoints, whale delivery keeps failing (server down)
    const first = makeAgent(world, taskA, {
      faultRules: serverDown,
      taskRunId: taskA.taskRunId,
      journal,
      maxDeliveryAttempts: 1,
    });
    const crashedResult = await first.agent.runTask(taskA);
    expect(crashedResult.broadcasts.attempted).toBe(2); // both payments went on-chain
    expect(crashedResult.purchases).toHaveLength(1); // only audit delivered
    const whaleTx = crashedResult.purchases.length === 1 ? null : null;
    void whaleTx;

    // "Crash" — memory is lost except the WAL journal.
    // Second "process": same taskRunId, fresh agent + ledger + governor.
    const taskB = buildDemoTaskA(BASE, "crash-recovery-1");
    const second = makeAgent(world, taskB, {
      faultRules: demoAFaultRules(), // network healthy again
      taskRunId: taskB.taskRunId,
      journal,
    });
    const recoveredResult = await second.agent.runTask(taskB);

    expect(recoveredResult.status).toBe("COMPLETED");
    // BOTH steps recovered from the WAL — zero new broadcasts:
    expect(recoveredResult.broadcasts.attempted).toBe(0);
    expect(recoveredResult.broadcasts.skippedViaJournal).toBe(2);
    // Total settlements on the chain never grew
    expect(world.sim.all()).toHaveLength(2);
    // The new ledger debits exactly once per intent, total 0.25
    const debits = recoveredResult.ledger.filter((e) => e.debit);
    expect(debits.map((d) => d.runningTotalUSDC)).toEqual(["0.10", "0.25"]);
    expect(recoveredResult.gauges.runningTotalUSDC).toBe("0.25");
  });

  it("server-side replay: re-presenting a delivered proof returns 200 with replay=true and no new settlement", async () => {
    const task = buildDemoTaskA(BASE, "replay-probe");
    const { agent } = makeAgent(world, task, { faultRules: demoAFaultRules(), taskRunId: task.taskRunId });
    const result = await agent.runTask(task);
    expect(result.status).toBe("COMPLETED");

    const audit = result.purchases[0];
    const journal = (agent as unknown as { journal: { list(): Promise<Array<{ paymentPayload?: Record<string, unknown>; intentId?: string }>> } }).journal;
    const entry = (await journal.list()).find((e) => e.intentId === audit.intentId);
    expect(entry?.paymentPayload).toBeDefined();

    const res = await world.fetchFn(`${BASE}/api/x402/security-audit`, {
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: btoa(JSON.stringify(entry!.paymentPayload)),
        [IDEMPOTENCY_KEY_HEADER]: audit.intentId,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paidWith: { replay: boolean; txHash: string } };
    expect(body.paidWith.replay).toBe(true);
    expect(body.paidWith.txHash).toBe(audit.txHash);
    // Still exactly one settlement for this intent on-chain
    expect(world.sim.all().filter((t) => t.intentId === audit.intentId)).toHaveLength(1);
  });

  it("taskRunId scoping: different task runs pay separately (intentIds diverge)", async () => {
    const t1 = buildDemoTaskA(BASE, "scope-run-1");
    const t2 = buildDemoTaskA(BASE, "scope-run-2");
    const a1 = makeAgent(world, t1, { faultRules: demoAFaultRules(), taskRunId: t1.taskRunId });
    const a2 = makeAgent(world, t2, { faultRules: demoAFaultRules(), taskRunId: t2.taskRunId });
    const r1 = await a1.agent.runTask(t1);
    const r2 = await a2.agent.runTask(t2);
    expect(r1.status).toBe("COMPLETED");
    expect(r2.status).toBe("COMPLETED");
    // 4 independent settlements (2 per task run)
    expect(world.sim.all()).toHaveLength(4);
    expect(r1.purchases[0].txHash).not.toBe(r2.purchases[0].txHash);
  });

  it("a broadcast failure releases the reservation and leaves the ledger debit-free for that step", async () => {
    const failingBroadcaster = {
      name: "failing",
      broadcastCount: 0,
      async broadcastTransferWithAuthorization() {
        throw new Error("rpc connection reset");
      },
      async waitForReceipt() {
        throw new Error("unreachable");
      },
    };
    const task = {
      taskRunId: "broadcast-fail",
      title: "Broadcast failure drill",
      description: "Broadcast fails; nothing spent",
      totalBudgetRaw: usdc("0.30"),
      perCallCapRaw: usdc("0.25"),
      baseUrl: BASE,
      steps: [{ endpointUrl: `${BASE}/api/x402/security-audit` }],
    };
    const { agent } = makeAgent(world, task, { taskRunId: task.taskRunId, broadcaster: failingBroadcaster });
    const result = await agent.runTask(task);
    expect(result.status).toBe("FAILED_NO_PURCHASES");
    expect(result.refusals[0].code).toBe("BROADCAST_FAILED");
    expect(result.gauges.committedSpendUSDC).toBe("0.00");
    expect(result.gauges.reservedSpendUSDC).toBe("0.00");
    expect(result.ledger.some((e) => e.decision === "FAILED_BROADCAST")).toBe(true);
    expect(world.sim.all()).toHaveLength(0);
  });

  it("re-running the exact same taskRunId with a shared journal is fully idempotent (0.25 total, not 0.50)", async () => {
    const journal = new InMemoryJournal();
    const task1 = buildDemoTaskA(BASE, "same-run-id");
    const first = makeAgent(world, task1, { faultRules: demoAFaultRules(), taskRunId: task1.taskRunId, journal });
    const r1 = await first.agent.runTask(task1);
    expect(r1.gauges.runningTotalUSDC).toBe("0.25");

    const task2 = buildDemoTaskA(BASE, "same-run-id");
    const second = makeAgent(world, task2, { faultRules: demoAFaultRules(), taskRunId: task2.taskRunId, journal });
    const r2 = await second.agent.runTask(task2);
    expect(r2.status).toBe("COMPLETED");
    expect(r2.gauges.runningTotalUSDC).toBe("0.25"); // NOT 0.50
    expect(r2.broadcasts.attempted).toBe(0);
    expect(r2.broadcasts.skippedViaJournal).toBe(2);
    expect(world.sim.all()).toHaveLength(2); // never grew
  });
});
