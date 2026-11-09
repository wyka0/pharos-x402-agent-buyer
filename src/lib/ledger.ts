/**
 * Requirement 03 — immutable, structured PaymentLedger.
 *
 * Records every PAID and REFUSED call with: step index, timestamp, endpoint,
 * what was bought, price (raw + formatted), on-chain txHash (+ PharosScan link),
 * block number, running spend total, and remaining budget. Debiting the same
 * intentId twice throws — belt-and-braces on top of the idempotency engine.
 */
import { explorerTxUrl } from "./chain";
import { formatUsdc } from "./format";
import type { RefusalCode } from "./budget";
import type { Hex } from "./x402";

export type LedgerDecision =
  | "PAID"
  | "RETRIED_DELIVERED"
  | "FAILED_BROADCAST"
  | "REFUSED_OVER_PER_CALL_CAP"
  | "REFUSED_OVER_TOTAL_BUDGET"
  | "REFUSED_LOW_UTILITY";

export interface LedgerEntry {
  readonly seq: number;
  readonly stepIndex: number;
  readonly timestamp: string; // ISO
  readonly intentId: Hex;
  readonly endpointUrl: string;
  readonly endpointLabel: string;
  readonly whatItBought: string;
  readonly decision: LedgerDecision;
  readonly debit: boolean; // true => counted in runningTotal
  readonly priceRaw: bigint;
  readonly priceUSDC: string;
  readonly txHash?: Hex;
  readonly blockNumber?: string;
  readonly explorerUrl?: string;
  readonly runningTotalRaw: bigint;
  readonly runningTotalUSDC: string;
  readonly remainingBudgetRaw: bigint;
  readonly remainingBudgetUSDC: string;
  readonly refusalCode?: RefusalCode | "BROADCAST_FAILED";
  readonly message?: string;
  readonly settlementCommitment?: Hex;
}

export interface PaidEntryInput {
  stepIndex: number;
  intentId: Hex;
  endpointUrl: string;
  endpointLabel: string;
  whatItBought: string;
  priceRaw: bigint;
  txHash: Hex;
  blockNumber?: bigint;
  runningTotalRaw: bigint; // after this debit
  remainingBudgetRaw: bigint;
  settlementCommitment?: Hex;
  now?: () => Date;
}

export interface RefusedEntryInput {
  stepIndex: number;
  intentId: Hex;
  endpointUrl: string;
  endpointLabel: string;
  whatItBought: string;
  priceRaw: bigint;
  refusalCode: RefusalCode | "BROADCAST_FAILED";
  message: string;
  runningTotalRaw: bigint;
  remainingBudgetRaw: bigint;
  now?: () => Date;
}

export interface RetryDeliveredInput {
  stepIndex: number;
  intentId: Hex;
  endpointUrl: string;
  endpointLabel: string;
  whatItBought: string;
  priceRaw: bigint;
  txHash: Hex;
  blockNumber?: bigint;
  attempt: number;
  replay: boolean;
  runningTotalRaw: bigint;
  remainingBudgetRaw: bigint;
  settlementCommitment?: Hex;
  now?: () => Date;
}

export class DuplicateLedgerDebitError extends Error {
  constructor(readonly intentId: Hex) {
    super(`Ledger integrity violation: intent ${intentId} was debited more than once.`);
    this.name = "DuplicateLedgerDebitError";
  }
}

export class PaymentLedger {
  private entries: LedgerEntry[] = [];
  private readonly debitedIntents = new Set<string>();
  private seq = 0;

  constructor(
    readonly taskRunId: string,
    readonly totalBudgetRaw: bigint,
    readonly perCallCapRaw: bigint,
  ) {}

  recordPaid(input: PaidEntryInput): LedgerEntry {
    if (this.debitedIntents.has(input.intentId)) throw new DuplicateLedgerDebitError(input.intentId);
    this.debitedIntents.add(input.intentId);
    const entry: LedgerEntry = {
      seq: ++this.seq,
      stepIndex: input.stepIndex,
      timestamp: (input.now?.() ?? new Date()).toISOString(),
      intentId: input.intentId,
      endpointUrl: input.endpointUrl,
      endpointLabel: input.endpointLabel,
      whatItBought: input.whatItBought,
      decision: "PAID",
      debit: true,
      priceRaw: input.priceRaw,
      priceUSDC: formatUsdc(input.priceRaw),
      txHash: input.txHash,
      blockNumber: input.blockNumber !== undefined ? input.blockNumber.toString() : undefined,
      explorerUrl: explorerTxUrl(input.txHash),
      runningTotalRaw: input.runningTotalRaw,
      runningTotalUSDC: formatUsdc(input.runningTotalRaw),
      remainingBudgetRaw: input.remainingBudgetRaw,
      remainingBudgetUSDC: formatUsdc(input.remainingBudgetRaw),
      settlementCommitment: input.settlementCommitment,
      message: `Settled ${formatUsdc(input.priceRaw)} USDC on Pharos Atlantic.`,
    };
    this.entries.push(entry);
    return entry;
  }

  recordRefused(input: RefusedEntryInput): LedgerEntry {
    const entry: LedgerEntry = {
      seq: ++this.seq,
      stepIndex: input.stepIndex,
      timestamp: (input.now?.() ?? new Date()).toISOString(),
      intentId: input.intentId,
      endpointUrl: input.endpointUrl,
      endpointLabel: input.endpointLabel,
      whatItBought: input.whatItBought,
      decision: ledgerDecisionForRefusal(input.refusalCode),
      debit: false,
      priceRaw: input.priceRaw,
      priceUSDC: formatUsdc(input.priceRaw),
      runningTotalRaw: input.runningTotalRaw,
      runningTotalUSDC: formatUsdc(input.runningTotalRaw),
      remainingBudgetRaw: input.remainingBudgetRaw,
      remainingBudgetUSDC: formatUsdc(input.remainingBudgetRaw),
      refusalCode: input.refusalCode,
      message: input.message,
    };
    this.entries.push(entry);
    return entry;
  }

  /** Non-debit audit entry marking that a paid call was delivered after retries/replay. */
  recordRetryDelivered(input: RetryDeliveredInput): LedgerEntry {
    const entry: LedgerEntry = {
      seq: ++this.seq,
      stepIndex: input.stepIndex,
      timestamp: (input.now?.() ?? new Date()).toISOString(),
      intentId: input.intentId,
      endpointUrl: input.endpointUrl,
      endpointLabel: input.endpointLabel,
      whatItBought: input.whatItBought,
      decision: "RETRIED_DELIVERED",
      debit: false,
      priceRaw: input.priceRaw,
      priceUSDC: formatUsdc(input.priceRaw),
      txHash: input.txHash,
      blockNumber: input.blockNumber !== undefined ? input.blockNumber.toString() : undefined,
      explorerUrl: explorerTxUrl(input.txHash),
      runningTotalRaw: input.runningTotalRaw,
      runningTotalUSDC: formatUsdc(input.runningTotalRaw),
      remainingBudgetRaw: input.remainingBudgetRaw,
      remainingBudgetUSDC: formatUsdc(input.remainingBudgetRaw),
      settlementCommitment: input.settlementCommitment,
      message: `Delivered on attempt ${input.attempt}${input.replay ? " via idempotent server-side replay (no double charge)" : ""}; no additional debit.`,
    };
    this.entries.push(entry);
    return entry;
  }

  recordBroadcastFailed(input: Omit<RefusedEntryInput, "refusalCode">): LedgerEntry {
    return this.recordRefused({ ...input, refusalCode: "BROADCAST_FAILED" });
  }

  entriesSnapshot(): readonly LedgerEntry[] {
    return [...this.entries];
  }

  paidEntries(): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.debit);
  }

  refusedEntries(): readonly LedgerEntry[] {
    return this.entries.filter((e) => e.decision.startsWith("REFUSED"));
  }

  lastRunningTotalRaw(): bigint {
    const last = this.entries.at(-1);
    return last ? last.runningTotalRaw : 0n;
  }

  lastRemainingBudgetRaw(): bigint {
    const last = this.entries.at(-1);
    return last ? last.remainingBudgetRaw : this.totalBudgetRaw;
  }
}

export function ledgerDecisionForRefusal(code: RefusalCode | "BROADCAST_FAILED"): LedgerDecision {
  switch (code) {
    case "REFUSED_OVER_PER_CALL_CAP":
      return "REFUSED_OVER_PER_CALL_CAP";
    case "REFUSED_OVER_TOTAL_BUDGET":
      return "REFUSED_OVER_TOTAL_BUDGET";
    case "REFUSED_LOW_UTILITY":
      return "REFUSED_LOW_UTILITY";
    case "BROADCAST_FAILED":
      return "FAILED_BROADCAST";
  }
}
