import { describe, it, expect } from "vitest";
import { PaymentLedger, DuplicateLedgerDebitError, ledgerDecisionForRefusal } from "@/lib/ledger";
import type { Hex } from "@/lib/x402";

const intent = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const tx = (n: number) => ("0x" + (n + 1).toString(16).padStart(64, "0")) as Hex;

function paid(ledger: PaymentLedger, step: number, id: Hex, priceRaw: bigint, running: bigint, remaining: bigint, hash?: Hex) {
  return ledger.recordPaid({
    stepIndex: step,
    intentId: id,
    endpointUrl: `http://test.local/step${step}`,
    endpointLabel: `Step ${step}`,
    whatItBought: "test data",
    priceRaw,
    txHash: hash ?? tx(step),
    blockNumber: 100n + BigInt(step),
    runningTotalRaw: running,
    remainingBudgetRaw: remaining,
  });
}

describe("Requirement 03: PaymentLedger", () => {
  it("records a paid entry with all required fields", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    const entry = paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    expect(entry.seq).toBe(1);
    expect(entry.stepIndex).toBe(0);
    expect(entry.decision).toBe("PAID");
    expect(entry.debit).toBe(true);
    expect(entry.priceRaw).toBe(100_000n);
    expect(entry.priceUSDC).toBe("0.10");
    expect(entry.txHash).toBe(tx(0));
    expect(entry.blockNumber).toBe("100");
    expect(entry.explorerUrl).toContain("atlantic.pharosscan.xyz/tx/");
    expect(entry.runningTotalUSDC).toBe("0.10");
    expect(entry.remainingBudgetUSDC).toBe("0.20");
    expect(entry.timestamp).toBeTruthy();
    expect(entry.whatItBought).toBeTruthy();
  });

  it("maintains an increasing seq across mixed entries", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    ledger.recordRefused({
      stepIndex: 1,
      intentId: intent(2),
      endpointUrl: "http://test.local/step1",
      endpointLabel: "Step 1",
      whatItBought: "trap",
      priceRaw: 500_000n,
      refusalCode: "REFUSED_OVER_PER_CALL_CAP",
      message: "over cap",
      runningTotalRaw: 100_000n,
      remainingBudgetRaw: 200_000n,
    });
    paid(ledger, 2, intent(3), 150_000n, 250_000n, 50_000n);
    const entries = ledger.entriesSnapshot();
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.decision)).toEqual(["PAID", "REFUSED_OVER_PER_CALL_CAP", "PAID"]);
  });

  it("throws a DuplicateLedgerDebitError when the same intent is debited twice", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(7), 100_000n, 100_000n, 200_000n);
    expect(() => paid(ledger, 0, intent(7), 100_000n, 200_000n, 100_000n)).toThrow(DuplicateLedgerDebitError);
    // The duplicate must NOT have been appended
    expect(ledger.entriesSnapshot()).toHaveLength(1);
  });

  it("refused entries carry refusal codes and never debit", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    const capRefusal = ledger.recordRefused({
      stepIndex: 1,
      intentId: intent(2),
      endpointUrl: "http://test.local/mev",
      endpointLabel: "MEV",
      whatItBought: "mev sim",
      priceRaw: 200_000n,
      refusalCode: "REFUSED_OVER_PER_CALL_CAP",
      message: "0.20 > 0.18 cap",
      runningTotalRaw: 100_000n,
      remainingBudgetRaw: 100_000n,
    });
    expect(capRefusal.debit).toBe(false);
    expect(capRefusal.refusalCode).toBe("REFUSED_OVER_PER_CALL_CAP");
    expect(capRefusal.runningTotalRaw).toBe(100_000n); // unchanged
    expect(capRefusal.explorerUrl).toBeUndefined();
  });

  it("retried-delivered entries are non-debit audit records with the same totals", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(1), 150_000n, 150_000n, 150_000n);
    const retried = ledger.recordRetryDelivered({
      stepIndex: 0,
      intentId: intent(1),
      endpointUrl: "http://test.local/whale",
      endpointLabel: "Whale",
      whatItBought: "whale data",
      priceRaw: 150_000n,
      txHash: tx(0),
      blockNumber: 101n,
      attempt: 2,
      replay: true,
      runningTotalRaw: 150_000n,
      remainingBudgetRaw: 150_000n,
    });
    expect(retried.decision).toBe("RETRIED_DELIVERED");
    expect(retried.debit).toBe(false);
    expect(retried.message).toContain("no additional debit");
    expect(retried.message).toContain("idempotent server-side replay");
  });

  it("paidEntries() / refusedEntries() partition correctly", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    ledger.recordRefused({
      stepIndex: 1,
      intentId: intent(2),
      endpointUrl: "u",
      endpointLabel: "l",
      whatItBought: "w",
      priceRaw: 150_000n,
      refusalCode: "REFUSED_OVER_TOTAL_BUDGET",
      message: "over budget",
      runningTotalRaw: 100_000n,
      remainingBudgetRaw: 100_000n,
    });
    paid(ledger, 2, intent(3), 50_000n, 150_000n, 150_000n);
    expect(ledger.paidEntries()).toHaveLength(2);
    expect(ledger.refusedEntries()).toHaveLength(1);
    expect(ledger.refusedEntries()[0].refusalCode).toBe("REFUSED_OVER_TOTAL_BUDGET");
  });

  it("lastRunningTotalRaw / lastRemainingBudgetRaw read the latest entry", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    expect(ledger.lastRunningTotalRaw()).toBe(0n);
    expect(ledger.lastRemainingBudgetRaw()).toBe(300_000n);
    paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    expect(ledger.lastRunningTotalRaw()).toBe(100_000n);
    expect(ledger.lastRemainingBudgetRaw()).toBe(200_000n);
  });

  it("records broadcast failures as FAILED_BROADCAST without a debit", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    const failed = ledger.recordBroadcastFailed({
      stepIndex: 0,
      intentId: intent(9),
      endpointUrl: "http://test.local/x",
      endpointLabel: "X",
      whatItBought: "data",
      priceRaw: 100_000n,
      message: "rpc down",
      runningTotalRaw: 0n,
      remainingBudgetRaw: 300_000n,
    });
    expect(failed.decision).toBe("FAILED_BROADCAST");
    expect(failed.debit).toBe(false);
    expect(failed.refusalCode).toBe("BROADCAST_FAILED");
  });

  it("maps refusal codes to ledger decisions exhaustively", () => {
    expect(ledgerDecisionForRefusal("REFUSED_OVER_PER_CALL_CAP")).toBe("REFUSED_OVER_PER_CALL_CAP");
    expect(ledgerDecisionForRefusal("REFUSED_OVER_TOTAL_BUDGET")).toBe("REFUSED_OVER_TOTAL_BUDGET");
    expect(ledgerDecisionForRefusal("REFUSED_LOW_UTILITY")).toBe("REFUSED_LOW_UTILITY");
    expect(ledgerDecisionForRefusal("BROADCAST_FAILED")).toBe("FAILED_BROADCAST");
  });

  it("entriesSnapshot() returns a defensive copy", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    paid(ledger, 0, intent(1), 100_000n, 100_000n, 200_000n);
    const snapshot = [...ledger.entriesSnapshot()];
    snapshot.pop();
    expect(ledger.entriesSnapshot()).toHaveLength(1);
  });

  it("formats large running totals without float drift", () => {
    const ledger = new PaymentLedger("run-1", 1_000_000_000n, 250_000n);
    const entry = paid(ledger, 0, intent(1), 999_999_999n, 999_999_999n, 1n);
    expect(entry.runningTotalUSDC).toBe("999.999999");
    expect(entry.remainingBudgetUSDC).toBe("0.000001");
  });

  it("carries the settlementCommitment on paid entries", () => {
    const ledger = new PaymentLedger("run-1", 300_000n, 250_000n);
    const commitment = ("0x" + "77".repeat(32)) as Hex;
    const entry = ledger.recordPaid({
      stepIndex: 0,
      intentId: intent(1),
      endpointUrl: "u",
      endpointLabel: "l",
      whatItBought: "w",
      priceRaw: 100_000n,
      txHash: tx(0),
      runningTotalRaw: 100_000n,
      remainingBudgetRaw: 200_000n,
      settlementCommitment: commitment,
    });
    expect(entry.settlementCommitment).toBe(commitment);
  });
});
