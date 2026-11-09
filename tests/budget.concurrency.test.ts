import { describe, it, expect } from "vitest";
import { BudgetGovernor, Mutex } from "@/lib/budget";
import { parseUsdcToRaw } from "@/lib/format";

const usdc = (s: string) => parseUsdcToRaw(s);

describe("Innovation #4: concurrent budget reservation locks", () => {
  it("ten concurrent reservations cannot exceed the total budget", () => {
    // 0.10 USDC budget, each call 0.04 -> at most 2 can be reserved/approved
    const g = new BudgetGovernor({ totalBudgetRaw: usdc("0.10"), perCallCapRaw: usdc("0.25") });
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      try {
        g.reserve(`intent-${i}`, usdc("0.04"));
        outcomes.push("approved");
      } catch {
        outcomes.push("refused");
      }
    }
    expect(outcomes.filter((o) => o === "approved")).toHaveLength(2);
    expect(outcomes.filter((o) => o === "refused")).toHaveLength(8);
    expect(g.snapshot().reservedSpendRaw).toBe(usdc("0.08"));
    expect(g.snapshot().remainingBudgetRaw).toBe(usdc("0.02"));
  });

  it("committing concurrently keeps committed spend exact", () => {
    const g = new BudgetGovernor({ totalBudgetRaw: usdc("1.00"), perCallCapRaw: usdc("0.25") });
    for (let i = 0; i < 4; i++) g.reserve(`intent-${i}`, usdc("0.25"));
    for (let i = 0; i < 4; i++) g.commit(`intent-${i}`);
    const snap = g.snapshot();
    expect(snap.committedSpendRaw).toBe(usdc("1.00"));
    expect(snap.remainingBudgetRaw).toBe(0n);
    expect(g.evaluate(usdc("0.01")).verdict).toBe("REFUSED_OVER_TOTAL_BUDGET");
  });

  it("async tool calls serialized by the mutex cannot race past the budget", async () => {
    const g = new BudgetGovernor({ totalBudgetRaw: usdc("0.15"), perCallCapRaw: usdc("0.25") });
    const mutex = new Mutex();
    const approved: string[] = [];
    const refused: string[] = [];

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        mutex.runExclusive(async () => {
          // Simulated async tool: read latest state, then reserve atomically.
          const snap = g.snapshot();
          if (snap.remainingBudgetRaw >= usdc("0.05")) {
            try {
              g.reserve(`intent-${i}`, usdc("0.05"));
              g.commit(`intent-${i}`);
              approved.push(`intent-${i}`);
              return;
            } catch {
              /* lost the race inside the critical section */
            }
          }
          refused.push(`intent-${i}`);
        }),
      ),
    );

    expect(approved).toHaveLength(3);
    expect(refused).toHaveLength(9);
    expect(g.snapshot().committedSpendRaw).toBe(usdc("0.15"));
  });

  it("releasing failed reservations returns capacity to concurrent callers", async () => {
    const g = new BudgetGovernor({ totalBudgetRaw: usdc("0.10"), perCallCapRaw: usdc("0.25") });
    g.reserve("first", usdc("0.10"));
    // 9 concurrent attempts all fail while the reservation is held
    const blocked = Array.from({ length: 9 }, (_, i) => {
      try {
        g.reserve(`blocked-${i}`, usdc("0.10"));
        return "approved";
      } catch {
        return "refused";
      }
    });
    expect(blocked.every((r) => r === "refused")).toBe(true);
    // Broadcast "fails": release returns the full budget
    g.release("first");
    try {
      g.reserve("retry", usdc("0.10"));
      g.commit("retry");
    } catch {
      throw new Error("should have been approvable after release");
    }
    expect(g.snapshot().committedSpendRaw).toBe(usdc("0.10"));
  });

  it("reservation + commit under a 0.30/0.25 budget matches the Demo A envelope", () => {
    const g = new BudgetGovernor({ totalBudgetRaw: usdc("0.30"), perCallCapRaw: usdc("0.25") });
    g.reserve("audit", usdc("0.10"));
    g.commit("audit");
    g.reserve("whale", usdc("0.15"));
    g.commit("whale");
    const snap = g.snapshot();
    expect(snap.committedSpendRaw).toBe(usdc("0.25"));
    expect(snap.remainingBudgetRaw).toBe(usdc("0.05"));
    // A third full-price call would still fit the budget, but the trap would not:
    expect(g.evaluate(usdc("0.50")).verdict).toBe("REFUSED_OVER_PER_CALL_CAP");
    expect(g.evaluate(usdc("0.05")).verdict).toBe("APPROVED");
  });
});
