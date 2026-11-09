import { describe, it, expect } from "vitest";
import { BudgetGovernor, BudgetExceededError, UnknownReservationError, Mutex } from "@/lib/budget";
import { parseUsdcToRaw } from "@/lib/format";

const usdc = (s: string) => parseUsdcToRaw(s);

function governor(budget: string, cap: string): BudgetGovernor {
  return new BudgetGovernor({ totalBudgetRaw: usdc(budget), perCallCapRaw: usdc(cap), id: "test" });
}

describe("Requirement 02: BudgetGovernor", () => {
  it("approves a call within cap and budget", () => {
    const g = governor("0.30", "0.25");
    const e = g.evaluate(usdc("0.10"));
    expect(e.verdict).toBe("APPROVED");
    expect(e.projectedRemainingRaw).toBe(usdc("0.20"));
  });

  it("approves a call exactly at the per-call cap (boundary)", () => {
    const g = governor("0.30", "0.25");
    expect(g.evaluate(usdc("0.25")).verdict).toBe("APPROVED");
  });

  it("refuses a call 1 raw unit above the per-call cap", () => {
    const g = governor("0.30", "0.25");
    const e = g.evaluate(usdc("0.25") + 1n);
    expect(e.verdict).toBe("REFUSED_OVER_PER_CALL_CAP");
    expect(e.message).toContain("per-call cap");
  });

  it("refuses the 0.50 trap endpoint against a 0.18 cap (Demo B)", () => {
    const g = governor("0.20", "0.18");
    const e = g.evaluate(usdc("0.50"));
    expect(e.verdict).toBe("REFUSED_OVER_PER_CALL_CAP");
  });

  it("refuses the 0.20 MEV call against a 0.18 cap (Demo B step 2)", () => {
    const g = governor("0.20", "0.18");
    expect(g.evaluate(usdc("0.20")).verdict).toBe("REFUSED_OVER_PER_CALL_CAP");
  });

  it("refuses when committed + price exceeds total budget", () => {
    const g = governor("0.20", "0.25");
    const id = "intent-1";
    g.reserve(id, usdc("0.10"));
    g.commit(id);
    const e = g.evaluate(usdc("0.15"));
    expect(e.verdict).toBe("REFUSED_OVER_TOTAL_BUDGET");
    expect(e.message).toContain("total budget");
  });

  it("approves a spend that lands exactly on the total budget (boundary)", () => {
    const g = governor("0.30", "0.25");
    g.reserve("a", usdc("0.10"));
    g.commit("a");
    g.reserve("b", usdc("0.15"));
    g.commit("b");
    expect(g.evaluate(usdc("0.05")).verdict).toBe("APPROVED");
    g.reserve("c", usdc("0.05"));
    g.commit("c");
    const snap = g.snapshot();
    expect(snap.runningTotalRaw).toBe(usdc("0.30"));
    expect(snap.remainingBudgetRaw).toBe(0n);
  });

  it("refuses when committed + reserved + price exceeds total budget", () => {
    const g = governor("0.30", "0.25");
    g.reserve("a", usdc("0.10"));
    g.commit("a");
    g.reserve("b", usdc("0.10")); // reserved, not yet committed
    const e = g.evaluate(usdc("0.15"));
    expect(e.verdict).toBe("REFUSED_OVER_TOTAL_BUDGET");
  });

  it("checks the per-call cap BEFORE the budget (spec order)", () => {
    const g = governor("0.05", "0.10"); // price above cap AND above budget
    const e = g.evaluate(usdc("0.15"));
    expect(e.verdict).toBe("REFUSED_OVER_PER_CALL_CAP");
  });

  it("reserve() throws BudgetExceededError and does not mutate state on refusal", () => {
    const g = governor("0.10", "0.25");
    expect(() => g.reserve("x", usdc("0.15"))).toThrow(BudgetExceededError);
    expect(g.snapshot().reservedSpendRaw).toBe(0n);
    expect(g.snapshot().activeReservations).toBe(0);
  });

  it("reserve() rejects a duplicate intentId", () => {
    const g = governor("0.30", "0.25");
    g.reserve("intent", usdc("0.10"));
    expect(() => g.reserve("intent", usdc("0.10"))).toThrow(/already exists/);
  });

  it("commit() moves reserved spend into committed spend", () => {
    const g = governor("0.30", "0.25");
    g.reserve("intent", usdc("0.10"));
    expect(g.snapshot().reservedSpendRaw).toBe(usdc("0.10"));
    expect(g.snapshot().committedSpendRaw).toBe(0n);
    g.commit("intent");
    const snap = g.snapshot();
    expect(snap.committedSpendRaw).toBe(usdc("0.10"));
    expect(snap.reservedSpendRaw).toBe(0n);
    expect(snap.runningTotalRaw).toBe(usdc("0.10"));
    expect(snap.remainingBudgetRaw).toBe(usdc("0.20"));
  });

  it("release() returns reserved spend to the available budget", () => {
    const g = governor("0.30", "0.25");
    g.reserve("intent", usdc("0.25"));
    g.release("intent");
    const snap = g.snapshot();
    expect(snap.reservedSpendRaw).toBe(0n);
    expect(snap.remainingBudgetRaw).toBe(usdc("0.30"));
    expect(g.evaluate(usdc("0.25")).verdict).toBe("APPROVED");
  });

  it("commit()/release() on unknown intents throw", () => {
    const g = governor("0.30", "0.25");
    expect(() => g.commit("ghost")).toThrow(UnknownReservationError);
    expect(() => g.release("ghost")).toThrow(UnknownReservationError);
  });

  it("re-released budget allows a new reservation for the same funds", () => {
    const g = governor("0.30", "0.25");
    g.reserve("a", usdc("0.20"));
    g.release("a");
    g.reserve("b", usdc("0.20"));
    g.commit("b");
    expect(g.snapshot().committedSpendRaw).toBe(usdc("0.20"));
  });

  it("evaluate() is pure: repeated evaluation does not change the snapshot", () => {
    const g = governor("0.30", "0.25");
    g.evaluate(usdc("0.10"));
    g.evaluate(usdc("0.20"));
    g.evaluate(usdc("0.30"));
    const snap = g.snapshot();
    expect(snap.runningTotalRaw).toBe(0n);
    expect(g.evaluationHistory().length).toBe(3);
  });

  it("snapshot() reports active reservation count", () => {
    const g = governor("0.30", "0.25");
    g.reserve("a", usdc("0.05"));
    g.reserve("b", usdc("0.05"));
    expect(g.snapshot().activeReservations).toBe(2);
    g.commit("a");
    expect(g.snapshot().activeReservations).toBe(1);
  });

  it("refuses prices above budget even when below cap", () => {
    const g = governor("0.10", "0.25");
    expect(g.evaluate(usdc("0.20")).verdict).toBe("REFUSED_OVER_TOTAL_BUDGET");
  });

  it("handles bigint raw precision without float drift", () => {
    const g = governor("0.30", "0.25");
    // 1 raw unit at a time, 100_000 times = 0.10 USDC exactly
    for (let i = 0; i < 3; i++) {
      const id = `micro-${i}`;
      g.reserve(id, 33_333n);
      g.commit(id);
    }
    expect(g.snapshot().committedSpendRaw).toBe(99_999n);
    expect(g.evaluate(100_001n).verdict).toBe("APPROVED"); // 99,999 + 100,001 = 200,000 <= 300,000
    expect(g.evaluate(200_002n).verdict).toBe("REFUSED_OVER_TOTAL_BUDGET"); // 99,999 + 200,002 = 300,001
  });

  it("rejects negative configuration", () => {
    expect(() => new BudgetGovernor({ totalBudgetRaw: -1n, perCallCapRaw: 0n })).toThrow();
    expect(() => new BudgetGovernor({ totalBudgetRaw: 0n, perCallCapRaw: -1n })).toThrow();
  });
});

describe("Innovation #4: Mutex serialization", () => {
  it("runs exclusive sections serially", async () => {
    const mutex = new Mutex();
    const order: string[] = [];
    const jobs = Array.from({ length: 5 }, (_, i) =>
      mutex.runExclusive(async () => {
        order.push(`start-${i}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end-${i}`);
        return i;
      }),
    );
    const results = await Promise.all(jobs);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    // Each start must be immediately followed by its end (no interleaving)
    for (let i = 0; i < 5; i++) {
      expect(order[i * 2]).toBe(`start-${i}`);
      expect(order[i * 2 + 1]).toBe(`end-${i}`);
    }
  });

  it("propagates the result value", async () => {
    const mutex = new Mutex();
    const value = await mutex.runExclusive(async () => 42);
    expect(value).toBe(42);
  });

  it("a failing section does not break the queue", async () => {
    const mutex = new Mutex();
    await expect(mutex.runExclusive(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const value = await mutex.runExclusive(async () => "recovered");
    expect(value).toBe("recovered");
  });
});
