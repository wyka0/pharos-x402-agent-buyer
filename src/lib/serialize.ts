/**
 * JSON-safe serialization of agent results (bigint -> decimal strings) so route
 * handlers can return them with JSON.stringify without data loss.
 */
import type { TaskResult, PurchaseRecord, RefusalRecord } from "./agent/buyer";
import type { LedgerEntry } from "./ledger";

export interface SerializedLedgerEntry {
  seq: number;
  stepIndex: number;
  timestamp: string;
  intentId: string;
  endpointUrl: string;
  endpointLabel: string;
  whatItBought: string;
  decision: string;
  debit: boolean;
  priceRaw: string;
  priceUSDC: string;
  txHash?: string;
  blockNumber?: string;
  explorerUrl?: string;
  runningTotalRaw: string;
  runningTotalUSDC: string;
  remainingBudgetRaw: string;
  remainingBudgetUSDC: string;
  refusalCode?: string;
  message?: string;
  settlementCommitment?: string;
}

export interface SerializedPurchase extends Omit<PurchaseRecord, "priceRaw" | "blockNumber"> {
  priceRaw: string;
  blockNumber?: string;
}

export interface SerializedRefusal extends Omit<RefusalRecord, "priceRaw"> {
  priceRaw: string;
}

export interface SerializedTaskResult extends Omit<TaskResult, "ledger" | "purchases" | "refusals"> {
  ledger: SerializedLedgerEntry[];
  purchases: SerializedPurchase[];
  refusals: SerializedRefusal[];
}

export function serializeLedgerEntry(e: LedgerEntry): SerializedLedgerEntry {
  return {
    ...e,
    priceRaw: e.priceRaw.toString(),
    runningTotalRaw: e.runningTotalRaw.toString(),
    remainingBudgetRaw: e.remainingBudgetRaw.toString(),
  };
}

export function serializePurchase(p: PurchaseRecord): SerializedPurchase {
  return {
    ...p,
    priceRaw: p.priceRaw.toString(),
    blockNumber: p.blockNumber !== undefined ? p.blockNumber.toString() : undefined,
  };
}

export function serializeRefusal(r: RefusalRecord): SerializedRefusal {
  return { ...r, priceRaw: r.priceRaw.toString() };
}

export function serializeTaskResult(result: TaskResult): SerializedTaskResult {
  return {
    ...result,
    ledger: result.ledger.map(serializeLedgerEntry),
    purchases: result.purchases.map(serializePurchase),
    refusals: result.refusals.map(serializeRefusal),
  };
}
