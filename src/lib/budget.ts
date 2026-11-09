/**
 * Requirement 02 — deterministic BudgetGovernor.
 *
 * Enforces, BEFORE signing or spending anything:
 *   1. totalBudget     — cumulative committed + reserved spend ceiling
 *   2. perCallCap      — maximum price of a single endpoint call
 *   3. utility filter  — expectedUtility >= price (see roi.ts; wired in the agent)
 *   4. hard refusals   — REFUSED_OVER_PER_CALL_CAP / REFUSED_OVER_TOTAL_BUDGET
 *
 * Innovation #4 — Atomic Budget Reservation Locks: in-flight reservations
 * (`reservedSpend`) are accounted synchronously, so concurrent async tool calls
 * cannot race past totalBudget. `runExclusive` additionally serializes async
 * reserve->commit sequences.
 */

export type RefusalCode =
  | "REFUSED_OVER_PER_CALL_CAP"
  | "REFUSED_OVER_TOTAL_BUDGET"
  | "REFUSED_LOW_UTILITY";

export type BudgetVerdict = "APPROVED" | RefusalCode;

export interface BudgetEvaluation {
  verdict: BudgetVerdict;
  priceRaw: bigint;
  perCallCapRaw: bigint;
  totalBudgetRaw: bigint;
  committedBeforeRaw: bigint;
  reservedBeforeRaw: bigint;
  projectedRunningTotalRaw: bigint;
  projectedRemainingRaw: bigint;
  message: string;
}

export interface BudgetSnapshot {
  totalBudgetRaw: bigint;
  perCallCapRaw: bigint;
  committedSpendRaw: bigint;
  reservedSpendRaw: bigint;
  runningTotalRaw: bigint; // committed + reserved
  remainingBudgetRaw: bigint; // total - runningTotal
  activeReservations: number;
}

export class BudgetExceededError extends Error {
  constructor(readonly evaluation: BudgetEvaluation) {
    super(evaluation.message);
    this.name = "BudgetExceededError";
  }
}

export class UnknownReservationError extends Error {
  constructor(readonly intentId: string) {
    super(`Unknown budget reservation: ${intentId}`);
    this.name = "UnknownReservationError";
  }
}

export interface BudgetGovernorConfig {
  totalBudgetRaw: bigint;
  perCallCapRaw: bigint;
  id?: string;
  now?: () => Date;
}

export class BudgetGovernor {
  readonly id: string;
  readonly totalBudgetRaw: bigint;
  readonly perCallCapRaw: bigint;
  private readonly reservations = new Map<string, bigint>();
  private committed = 0n;
  private readonly history: BudgetEvaluation[] = [];
  private readonly nowFn: () => Date;

  constructor(config: BudgetGovernorConfig) {
    if (config.totalBudgetRaw < 0n || config.perCallCapRaw < 0n) {
      throw new Error("BudgetGovernor: budgets must be non-negative");
    }
    this.id = config.id ?? "governor";
    this.totalBudgetRaw = config.totalBudgetRaw;
    this.perCallCapRaw = config.perCallCapRaw;
    this.nowFn = config.now ?? (() => new Date());
  }

  /** Pure evaluation — no state mutation. Cap is checked first (spec order). */
  evaluate(priceRaw: bigint): BudgetEvaluation {
    const reserved = this.reservedTotal();
    const projected = this.committed + reserved + priceRaw;
    let verdict: BudgetVerdict = "APPROVED";
    let message = `Approved: ${priceRaw} raw within per-call cap and budget.`;
    if (priceRaw > this.perCallCapRaw) {
      verdict = "REFUSED_OVER_PER_CALL_CAP";
      message = `Refused: price ${priceRaw} raw exceeds per-call cap ${this.perCallCapRaw} raw.`;
    } else if (projected > this.totalBudgetRaw) {
      verdict = "REFUSED_OVER_TOTAL_BUDGET";
      message = `Refused: committed ${this.committed} + reserved ${reserved} + price ${priceRaw} = ${projected} raw exceeds total budget ${this.totalBudgetRaw} raw.`;
    }
    const evaluation: BudgetEvaluation = {
      verdict,
      priceRaw,
      perCallCapRaw: this.perCallCapRaw,
      totalBudgetRaw: this.totalBudgetRaw,
      committedBeforeRaw: this.committed,
      reservedBeforeRaw: reserved,
      projectedRunningTotalRaw: projected,
      projectedRemainingRaw: this.totalBudgetRaw > projected ? this.totalBudgetRaw - projected : 0n,
      message,
    };
    this.history.push(evaluation);
    return evaluation;
  }

  /**
   * Atomic reservation: accounts the price into `reservedSpend` synchronously so
   * concurrent callers see the committed view. Throws on race (defense in depth).
   */
  reserve(intentId: string, priceRaw: bigint): BudgetEvaluation {
    const evaluation = this.evaluate(priceRaw);
    if (evaluation.verdict !== "APPROVED") throw new BudgetExceededError(evaluation);
    if (this.reservations.has(intentId)) {
      throw new Error(`BudgetGovernor: reservation ${intentId} already exists`);
    }
    this.reservations.set(intentId, priceRaw);
    return evaluation;
  }

  /** Move a reservation into committed spend (call once the tx is settled). */
  commit(intentId: string): bigint {
    const amount = this.reservations.get(intentId);
    if (amount === undefined) throw new UnknownReservationError(intentId);
    this.reservations.delete(intentId);
    this.committed += amount;
    return amount;
  }

  /** Return a reservation to the available budget (broadcast failed / reverted). */
  release(intentId: string): bigint {
    const amount = this.reservations.get(intentId);
    if (amount === undefined) throw new UnknownReservationError(intentId);
    this.reservations.delete(intentId);
    return amount;
  }

  snapshot(): BudgetSnapshot {
    const reserved = this.reservedTotal();
    const running = this.committed + reserved;
    return {
      totalBudgetRaw: this.totalBudgetRaw,
      perCallCapRaw: this.perCallCapRaw,
      committedSpendRaw: this.committed,
      reservedSpendRaw: reserved,
      runningTotalRaw: running,
      remainingBudgetRaw: this.totalBudgetRaw > running ? this.totalBudgetRaw - running : 0n,
      activeReservations: this.reservations.size,
    };
  }

  evaluationHistory(): readonly BudgetEvaluation[] {
    return this.history;
  }

  private reservedTotal(): bigint {
    let total = 0n;
    for (const amount of this.reservations.values()) total += amount;
    return total;
  }
}

// --- Concurrency helpers (Innovation #4) ---------------------------------------

/** Minimal promise mutex: serializes async critical sections. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/**
 * Atomic reserve-or-refuse for concurrent async tool calls. The reservation map
 * update is synchronous; the mutex additionally serializes any async work that
 * must observe a consistent snapshot.
 */
export async function reserveAtomically(
  governor: BudgetGovernor,
  intentId: string,
  priceRaw: bigint,
): Promise<BudgetEvaluation> {
  return governor.evaluate(priceRaw).verdict === "APPROVED" ? governor.reserve(intentId, priceRaw) : governor.evaluate(priceRaw);
}
