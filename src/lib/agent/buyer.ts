/**
 * The x402 Buyer Agent (Requirements 01-05).
 *
 * For each task step:
 *   QUOTED_402   GET the endpoint -> decode + integrity-check the 402 challenge
 *   GATE         ROI (utility >= price) + BudgetGovernor (cap, budget) BEFORE signing
 *   PAY          reserve -> sign EIP-3009 -> WAL pre-record -> broadcast ->
 *                wait receipt -> commit + ledger debit -> WAL bind txHash
 *   DELIVER      re-request with the SAME PAYMENT-SIGNATURE proof (+ Idempotency-Key),
 *                retrying network faults idempotently; verify PAYMENT-RESPONSE
 *                (settlementCommitment, txHash, amount) before trusting data
 *
 * Crash safety: the WAL persists intentId -> proof before every HTTP re-submit;
 * recovery reuses the proof and NEVER broadcasts twice. The EIP-3009 nonce is
 * derived from the intentId, so the chain itself rejects any duplicate settle.
 */
import { keccak256, stringToHex, type Hex } from "viem";
import {
  decodePaymentRequired,
  encodePaymentPayload,
  IDEMPOTENCY_KEY_HEADER,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  type X402PaymentPayload,
  type X402PaymentRequirements,
} from "../x402";
import { computeIntentId, computeResourceHash, computeQuoteCommitment, bindSettlement } from "../commitment";
import { BudgetGovernor, type RefusalCode } from "../budget";
import { PaymentLedger, type LedgerEntry } from "../ledger";
import { evaluateRoi, type RoiEvaluation } from "../roi";
import { formatUsdc } from "../format";
import { explorerTxUrl, NETWORK_ID, CHAIN_ID } from "../chain";
import {
  InMemoryJournal,
  PaymentStateMachine,
  newJournalEntry,
  type JournalEntry,
  type PaymentState,
  type WriteAheadJournal,
} from "../idempotency";
import { buildAuthorization, signAuthorization, type SignerLike } from "../settlement/signer";
import type { BroadcastAdapter } from "../settlement/broadcast";
import type { CatalogEntry } from "../roi";
import { verifyDeliveryResponse } from "./verifyResponse";
import { FaultInjector, SimulatedNetworkError, type FaultRule } from "./faults";

// --- Public types --------------------------------------------------------------

export type AgentEventType =
  | "TASK_STARTED"
  | "STEP_STARTED"
  | "QUOTE_RECEIVED_402"
  | "QUOTE_INTEGRITY_FAILED"
  | "GATE_EVALUATED"
  | "LEDGER_DEBIT"
  | "REFUSED_OVER_PER_CALL_CAP"
  | "REFUSED_OVER_TOTAL_BUDGET"
  | "REFUSED_LOW_UTILITY"
  | "BUDGET_RESERVED"
  | "PAYMENT_SIGNING"
  | "PAYMENT_RECOVERED_FROM_WAL"
  | "PAYMENT_BROADCASTED"
  | "PAYMENT_RECEIPT_CONFIRMED"
  | "BROADCAST_FAILED"
  | "WAL_RECORDED"
  | "DELIVERY_ATTEMPT"
  | "DELIVERY_FAULT_INJECTED"
  | "DELIVERY_RETRYING"
  | "IDEMPOTENT_REPLAY_ACCEPTED"
  | "COMMITMENT_VERIFIED"
  | "DELIVERED_200"
  | "DELIVERY_FAILED"
  | "SYNTHESIS_READY"
  | "TASK_COMPLETED"
  | "TASK_HALTED";

export interface AgentEvent {
  seq: number;
  at: string;
  type: AgentEventType;
  message: string;
  data?: Record<string, unknown>;
}

export interface HeaderExchange {
  phase: "initial" | "delivery";
  attempt: number;
  requestHeaders: Record<string, string>;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  rawPaymentRequiredHeader?: string;
  rawPaymentResponseHeader?: string;
  paymentSignatureHeaderSent?: string;
  error?: string;
}

export interface StepHeaderLog {
  stepIndex: number;
  endpointUrl: string;
  label: string;
  exchanges: HeaderExchange[];
}

export interface PurchaseRecord {
  stepIndex: number;
  endpointUrl: string;
  label: string;
  whatItBought: string;
  priceRaw: bigint;
  priceUSDC: string;
  intentId: Hex;
  txHash: Hex;
  blockNumber?: bigint;
  explorerUrl?: string;
  attempt: number;
  serverReplay: boolean;
  quoteCommitment: Hex;
  settlementCommitment: Hex;
  data: unknown;
}

export interface RefusalRecord {
  stepIndex: number;
  endpointUrl: string;
  label: string;
  whatItBought: string;
  priceRaw: bigint;
  priceUSDC: string;
  code: RefusalCode | "BROADCAST_FAILED";
  message: string;
  roi?: RoiEvaluation;
}

export type TaskStatus =
  | "COMPLETED"
  | "HALTED_BUDGET_EXCEEDED"
  | "COMPLETED_WITH_PARTIAL_DATA"
  | "FAILED_NO_PURCHASES";

export interface TaskStep {
  /** Absolute URL, or a path resolved against the task baseUrl. */
  endpointUrl: string;
  label?: string;
  params?: Record<string, string>;
}

export interface AgentTask {
  taskRunId: string;
  title: string;
  description: string;
  totalBudgetRaw: bigint;
  perCallCapRaw: bigint;
  baseUrl: string;
  steps: TaskStep[];
  /** Optional task-specific synthesis over purchases + refusals. */
  synthesis?: (purchases: PurchaseRecord[], refusals: RefusalRecord[]) => Record<string, unknown>;
}

export interface TaskResult {
  taskRunId: string;
  title: string;
  description: string;
  status: TaskStatus;
  mode: "live" | "simulated";
  purchases: PurchaseRecord[];
  refusals: RefusalRecord[];
  ledger: LedgerEntry[];
  gauges: {
    totalBudgetUSDC: string;
    perCallCapUSDC: string;
    committedSpendUSDC: string;
    reservedSpendUSDC: string;
    runningTotalUSDC: string;
    remainingBudgetUSDC: string;
  };
  events: AgentEvent[];
  headerLog: StepHeaderLog[];
  broadcasts: { attempted: number; skippedViaJournal: number };
  faultsInjected: number;
  startedAt: string;
  finishedAt: string;
  synthesis: Record<string, unknown>;
}

export interface BuyerAgentDeps {
  governor: BudgetGovernor;
  ledger: PaymentLedger;
  journal?: WriteAheadJournal;
  broadcaster: BroadcastAdapter;
  signer: SignerLike;
  /** Agent-side value catalog keyed by endpoint URL (ground truth for ROI). */
  valueCatalog?: Record<string, CatalogEntry>;
  fetchFn?: typeof fetch;
  faultRules?: FaultRule[];
  maxDeliveryAttempts?: number;
  network?: string;
  chainId?: number;
  explorerBase?: string;
  now?: () => Date;
  mode?: "live" | "simulated";
  /** Skip payments entirely (probe-only dry run). */
  dryRun?: boolean;
}

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

export class BuyerAgent {
  private events: AgentEvent[] = [];
  private headerLog: StepHeaderLog[] = [];
  private eventSeq = 0;
  private readonly journal: WriteAheadJournal;
  private readonly faults: FaultInjector;
  private readonly nowFn: () => Date;
  private broadcastsAttempted = 0;
  private broadcastsSkippedViaJournal = 0;

  constructor(private readonly deps: BuyerAgentDeps) {
    this.journal = deps.journal ?? new InMemoryJournal();
    this.faults = new FaultInjector(deps.faultRules ?? []);
    this.nowFn = deps.now ?? (() => new Date());
  }

  transcript(): readonly AgentEvent[] {
    return this.events;
  }

  headerLogSnapshot(): readonly StepHeaderLog[] {
    return this.headerLog;
  }

  async runTask(task: AgentTask): Promise<TaskResult> {
    const startedAt = this.nowFn().toISOString();
    this.events = [];
    this.headerLog = [];
    this.broadcastsAttempted = 0;
    this.broadcastsSkippedViaJournal = 0;
    this.eventSeq = 0;
    const purchases: PurchaseRecord[] = [];
    const refusals: RefusalRecord[] = [];
    const maxAttempts = this.deps.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    const network = this.deps.network ?? NETWORK_ID;
    const chainId = this.deps.chainId ?? CHAIN_ID;

    this.emit("TASK_STARTED", `Task "${task.title}" started — budget ${formatUsdc(task.totalBudgetRaw)} USDC, per-call cap ${formatUsdc(task.perCallCapRaw)} USDC.`, {
      steps: task.steps.length,
    });

    for (let stepIndex = 0; stepIndex < task.steps.length; stepIndex++) {
      const step = task.steps[stepIndex];
      const url = resolveStepUrl(task.baseUrl, step);
      const label = step.label ?? catalogLabel(this.deps.valueCatalog, url) ?? url;
      const stepLog: StepHeaderLog = { stepIndex, endpointUrl: url, label, exchanges: [] };
      this.headerLog.push(stepLog);
      this.emit("STEP_STARTED", `Step ${stepIndex + 1}: ${label} -> ${url}`);

      // ---- Phase 1: initial request -> expect HTTP 402 ------------------------
      const initial = await this.fetchRecording(url, "initial", 1, {}, stepLog);
      if (initial instanceof Error || initial.status !== 402) {
        const detail = initial instanceof Error ? initial.message : `unexpected HTTP ${initial.status}`;
        this.emit("DELIVERY_FAILED", `Step ${stepIndex + 1}: expected a 402 quote, got ${detail}. Step skipped.`);
        refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", `No 402 quote: ${detail}`, 0n, undefined, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }
      const rawQuoteHeader = initial.headers.get(PAYMENT_REQUIRED_HEADER);
      if (!rawQuoteHeader) {
        this.emit("DELIVERY_FAILED", `Step ${stepIndex + 1}: 402 without ${PAYMENT_REQUIRED_HEADER} header. Step skipped.`);
        refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", "402 without PAYMENT-REQUIRED header", 0n, undefined, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }
      let challenge: X402PaymentRequirements;
      try {
        const decoded = decodePaymentRequired(rawQuoteHeader);
        if (decoded.accepts.length !== 1) throw new Error("expected exactly one accepted requirement");
        challenge = decoded.accepts[0];
      } catch (e) {
        this.emit("QUOTE_INTEGRITY_FAILED", `Step ${stepIndex + 1}: malformed quote — ${String(e)}`);
        refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", `Malformed quote: ${String(e)}`, 0n, undefined, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }
      const priceRaw = BigInt(challenge.maxAmountRequired);
      this.emit("QUOTE_RECEIVED_402", `Step ${stepIndex + 1}: quote received — ${formatUsdc(priceRaw)} USDC to ${shortAddr(challenge.payTo)} (${challenge.network}).`, {
        resource: challenge.resource,
        quoteCommitment: challenge.extra.quoteCommitment,
      });

      // Client-side integrity: recompute the quote commitment from decoded fields.
      const recomputed = computeQuoteCommitment({
        scheme: challenge.scheme,
        network: challenge.network,
        resource: challenge.resource,
        asset: challenge.asset,
        payTo: challenge.payTo,
        maxAmountRequired: challenge.maxAmountRequired,
        chainId: challenge.extra.chainId,
        nonce: challenge.extra.nonce,
      });
      if (recomputed !== challenge.extra.quoteCommitment) {
        this.emit("QUOTE_INTEGRITY_FAILED", `Step ${stepIndex + 1}: quoteCommitment mismatch — challenge tampered. Refusing without payment.`);
        refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", "quoteCommitment mismatch", priceRaw, undefined, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }

      // ---- Phase 2: gates (ROI + budget) BEFORE any signing -------------------
      const catalogEntry = this.deps.valueCatalog?.[url] ?? null;
      const roi = evaluateRoi(catalogEntry, priceRaw, challenge);
      const budget = this.deps.governor.evaluate(priceRaw);
      this.emit("GATE_EVALUATED", `Step ${stepIndex + 1}: ${roi.message} | ${budget.message}`, {
        roiVerdict: roi.verdict,
        budgetVerdict: budget.verdict,
        roi,
      });

      let refusalCode: RefusalCode | null = null;
      if (roi.verdict !== "APPROVED") refusalCode = "REFUSED_LOW_UTILITY";
      else if (budget.verdict === "REFUSED_OVER_PER_CALL_CAP") refusalCode = "REFUSED_OVER_PER_CALL_CAP";
      else if (budget.verdict === "REFUSED_OVER_TOTAL_BUDGET") refusalCode = "REFUSED_OVER_TOTAL_BUDGET";

      const intentId = computeIntentId(task.taskRunId, url, stepIndex, computeResourceHash(challenge.resource, challenge.maxAmountRequired, challenge.payTo));
      if (refusalCode) {
        const snap = this.deps.governor.snapshot();
        this.emit(`REFUSED_${refusalCode.replace("REFUSED_", "")}` as AgentEventType, `Step ${stepIndex + 1}: ${refusalCode} — nothing signed, nothing spent.`);
        this.deps.ledger.recordRefused({
          stepIndex,
          intentId,
          endpointUrl: url,
          endpointLabel: label,
          whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
          priceRaw,
          refusalCode,
          message: refusalCode === "REFUSED_LOW_UTILITY" ? roi.message : budget.message,
          runningTotalRaw: snap.committedSpendRaw,
          remainingBudgetRaw: snap.remainingBudgetRaw,
          now: this.nowFn,
        });
        refusals.push(mkRefusal(stepIndex, url, label, refusalCode, refusalCode === "REFUSED_LOW_UTILITY" ? roi.message : budget.message, priceRaw, roi, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }

      if (this.deps.dryRun) {
        this.emit("GATE_EVALUATED", `Step ${stepIndex + 1}: dry-run mode — gates passed, payment skipped.`);
        continue;
      }

      // ---- Phase 3: reserve + pay --------------------------------------------
      try {
        this.deps.governor.reserve(intentId, priceRaw);
      } catch {
        const snap = this.deps.governor.snapshot();
        this.emit("REFUSED_OVER_TOTAL_BUDGET", `Step ${stepIndex + 1}: reservation race lost — refused.`);
        this.deps.ledger.recordRefused({
          stepIndex,
          intentId,
          endpointUrl: url,
          endpointLabel: label,
          whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
          priceRaw,
          refusalCode: "REFUSED_OVER_TOTAL_BUDGET",
          message: "Concurrent reservations consumed the available budget.",
          runningTotalRaw: snap.committedSpendRaw,
          remainingBudgetRaw: snap.remainingBudgetRaw,
          now: this.nowFn,
        });
        refusals.push(mkRefusal(stepIndex, url, label, "REFUSED_OVER_TOTAL_BUDGET", "Concurrent reservations consumed the available budget.", priceRaw, roi, catalogWhat(this.deps.valueCatalog, url)));
        continue;
      }
      this.emit("BUDGET_RESERVED", `Step ${stepIndex + 1}: atomic budget reservation locked for ${formatUsdc(priceRaw)} USDC (intent ${shortHash(intentId)}).`);

      const resourceHash = computeResourceHash(challenge.resource, challenge.maxAmountRequired, challenge.payTo);

      let paymentPayload: X402PaymentPayload | null = null;
      let settledBlockNumber: bigint | undefined;
      const journaled = await this.journal.lookup(intentId);
      const state = new PaymentStateMachine(
        intentId,
        journaled?.paymentPayload && journaled.txHash ? "PAYMENT_BROADCASTED" : "QUOTED_402",
        this.nowFn,
      );
      if (journaled?.paymentPayload && journaled.txHash) {
        // Crash/retry recovery: the payment for THIS exact intent already exists.
        paymentPayload = journaled.paymentPayload;
        this.broadcastsSkippedViaJournal += 1;
        this.emit("PAYMENT_RECOVERED_FROM_WAL", `Step ${stepIndex + 1}: recovered paid proof from WAL — reusing tx ${shortHash(paymentPayload.txHash)}; NO new broadcast.`);
        // Re-confirm the settlement on-chain and account for it in THIS run's
        // ledger (the funds WERE spent, so the debit must appear exactly once).
        const receipt = await this.deps.broadcaster.waitForReceipt(paymentPayload.txHash);
        if (receipt.status !== "success") {
          state.transition("BROADCAST_FAILED");
          this.deps.governor.release(intentId);
          const snap = this.deps.governor.snapshot();
          this.emit("BROADCAST_FAILED", `Step ${stepIndex + 1}: recovered settlement ${shortHash(paymentPayload.txHash)} is not confirmed (${receipt.status}) — reservation released.`);
          this.deps.ledger.recordBroadcastFailed({
            stepIndex,
            intentId,
            endpointUrl: url,
            endpointLabel: label,
            whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
            priceRaw,
            message: `Recovered tx not confirmed: ${receipt.status}`,
            runningTotalRaw: snap.committedSpendRaw,
            remainingBudgetRaw: snap.remainingBudgetRaw,
            now: this.nowFn,
          });
          refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", "Recovered settlement not confirmed on-chain", priceRaw, roi, catalogWhat(this.deps.valueCatalog, url)));
          continue;
        }
        settledBlockNumber = receipt.blockNumber;
        this.deps.governor.commit(intentId);
        const snapRecovered = this.deps.governor.snapshot();
        this.deps.ledger.recordPaid({
          stepIndex,
          intentId,
          endpointUrl: url,
          endpointLabel: label,
          whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
          priceRaw,
          txHash: paymentPayload.txHash,
          blockNumber: receipt.blockNumber,
          runningTotalRaw: snapRecovered.committedSpendRaw,
          remainingBudgetRaw: snapRecovered.remainingBudgetRaw,
          settlementCommitment: paymentPayload.settlementCommitment,
          now: this.nowFn,
        });
        this.emit("LEDGER_DEBIT", `Step ${stepIndex + 1}: recovered debit ${formatUsdc(priceRaw)} USDC — running total ${formatUsdc(snapRecovered.committedSpendRaw)}/${formatUsdc(task.totalBudgetRaw)} USDC (no new tx).`);
      } else {        // Sign -> WAL pre-record -> broadcast -> receipt -> commit -> WAL bind.
        this.emit("PAYMENT_SIGNING", `Step ${stepIndex + 1}: signing EIP-3009 authorization (${formatUsdc(priceRaw)} USDC -> ${shortAddr(challenge.payTo)}).`);
        const nowSec = Math.floor(this.nowFn().getTime() / 1000);
        const authorization = buildAuthorization({
          payer: this.deps.signer.address,
          payTo: challenge.payTo as `0x${string}`,
          amountRaw: priceRaw,
          intentId,
          nowSec,
        });
        const signature = await signAuthorization(this.deps.signer, authorization, challenge.asset as `0x${string}`);

        const quoteCommitment = challenge.extra.quoteCommitment;
        let txHash: Hex | null = null;
        let blockNumber: bigint | undefined;
        try {
          state.transition("PAYMENT_BROADCASTING");
          const preEntry = newJournalEntry({
            intentId,
            taskRunId: task.taskRunId,
            stepIndex,
            endpointUrl: url,
            resourceHash,
            priceRaw,
            state: "PAYMENT_BROADCASTING",
            now: this.nowFn,
          });
          await this.journal.record(preEntry);
          this.emit("WAL_RECORDED", `Step ${stepIndex + 1}: WAL pre-record (PAYMENT_BROADCASTING) — crash-safe before any network re-submit.`);

          this.broadcastsAttempted += 1;
          const broadcast = await this.deps.broadcaster.broadcastTransferWithAuthorization({ authorization, signature, intentId });
          txHash = broadcast.txHash;
          this.emit("PAYMENT_BROADCASTED", `Step ${stepIndex + 1}: settlement broadcast on Pharos Atlantic — tx ${shortHash(txHash)} (${broadcast.strategy}).`, {
            txHash,
          });
          const receipt = await this.deps.broadcaster.waitForReceipt(txHash);
          if (receipt.status !== "success") {
            throw new Error(`settlement tx ${txHash} reverted`);
          }
          blockNumber = receipt.blockNumber;
          settledBlockNumber = receipt.blockNumber;
          this.emit("PAYMENT_RECEIPT_CONFIRMED", `Step ${stepIndex + 1}: settlement confirmed in block ${blockNumber}.`, { blockNumber: blockNumber.toString() });
        } catch (e) {
          state.transition("BROADCAST_FAILED");
          this.deps.governor.release(intentId);
          const snap = this.deps.governor.snapshot();
          this.emit("BROADCAST_FAILED", `Step ${stepIndex + 1}: broadcast failed (${String(e)}) — reservation released, nothing spent.`);
          this.deps.ledger.recordBroadcastFailed({
            stepIndex,
            intentId,
            endpointUrl: url,
            endpointLabel: label,
            whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
            priceRaw,
            message: `Broadcast failed: ${String(e)}`,
            runningTotalRaw: snap.committedSpendRaw,
            remainingBudgetRaw: snap.remainingBudgetRaw,
            now: this.nowFn,
          });
          refusals.push(mkRefusal(stepIndex, url, label, "BROADCAST_FAILED", `Broadcast failed: ${String(e)}`, priceRaw, roi, catalogWhat(this.deps.valueCatalog, url)));
          continue;
        }

        // Funds moved: commit the reservation and debit the ledger exactly once.
        this.deps.governor.commit(intentId);
        const snapAfterCommit = this.deps.governor.snapshot();
        const settlementCommitment = bindSettlement(quoteCommitment, txHash);
        paymentPayload = {
          x402Version: 2,
          scheme: "exact",
          network,
          resource: challenge.resource,
          requirementsEcho: challenge,
          intentId,
          authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
          },
          signature,
          txHash,
          quoteCommitment,
          settlementCommitment,
        };
        this.deps.ledger.recordPaid({
          stepIndex,
          intentId,
          endpointUrl: url,
          endpointLabel: label,
          whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
          priceRaw,
          txHash,
          blockNumber,
          runningTotalRaw: snapAfterCommit.committedSpendRaw,
          remainingBudgetRaw: snapAfterCommit.remainingBudgetRaw,
          settlementCommitment,
          now: this.nowFn,
        });
        this.emit("LEDGER_DEBIT" as AgentEventType, `Step ${stepIndex + 1}: ledger debit ${formatUsdc(priceRaw)} USDC — running total ${formatUsdc(snapAfterCommit.committedSpendRaw)}/${formatUsdc(task.totalBudgetRaw)} USDC.`);

        state.transition("PAYMENT_BROADCASTED");
        const paidEntry = newJournalEntry({
          intentId,
          taskRunId: task.taskRunId,
          stepIndex,
          endpointUrl: url,
          resourceHash,
          priceRaw,
          state: "PAYMENT_BROADCASTED",
          now: this.nowFn,
        });
        paidEntry.txHash = txHash;
        paidEntry.paymentPayload = paymentPayload;
        await this.journal.record(paidEntry);
        this.emit("WAL_RECORDED", `Step ${stepIndex + 1}: WAL bound intent -> tx ${shortHash(txHash)} before any HTTP re-submit.`, { txHash });
      }

      if (!paymentPayload) continue; // unreachable

      // ---- Phase 4: delivery with idempotent retries ---------------------------
      state.transition("DELIVERY_PENDING");
      const signatureHeader = encodePaymentPayload(paymentPayload);
      let delivered: { response: Response; attempt: number } | null = null;
      let lastError = "";

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.emit("DELIVERY_ATTEMPT", `Step ${stepIndex + 1}: delivery attempt ${attempt}/${maxAttempts} with the SAME payment proof (idempotency key ${shortHash(intentId)}).`);
        const injected = this.faults.apply(url, "delivery_attempt", attempt);
        let response: Response | Error;
        if (injected === "network_error") {
          const simErr = new SimulatedNetworkError("drop_connection", url, attempt);
          this.emit("DELIVERY_FAULT_INJECTED", `Step ${stepIndex + 1}: simulated network drop AFTER payment broadcast (attempt ${attempt}) — retrying with the same proof, no new tx.`);
          response = simErr;
        } else if (injected) {
          this.emit("DELIVERY_FAULT_INJECTED", `Step ${stepIndex + 1}: simulated HTTP ${injected.status} after payment (attempt ${attempt}).`);
          response = injected;
        } else {
          response = await this.fetchRecording(url, "delivery", attempt, {
            [PAYMENT_SIGNATURE_HEADER]: signatureHeader,
            [IDEMPOTENCY_KEY_HEADER]: intentId,
          }, stepLog, signatureHeader);
        }

        if (response instanceof Error) {
          lastError = response.message;
          if (attempt < maxAttempts) {
            this.emit("DELIVERY_RETRYING", `Step ${stepIndex + 1}: ${lastError} — safe retry ${attempt + 1} with identical proof.`);
            continue;
          }
          break;
        }

        // record the exchange for the inspector
        stepLog.exchanges.push({
          phase: "delivery",
          attempt,
          requestHeaders: {
            [PAYMENT_SIGNATURE_HEADER]: `<base64 payload, ${signatureHeader.length} chars>`,
            [IDEMPOTENCY_KEY_HEADER]: intentId,
          },
          responseStatus: response.status,
          responseHeaders: Object.fromEntries(response.headers.entries()),
          rawPaymentResponseHeader: response.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined,
          paymentSignatureHeaderSent: signatureHeader,
          error: response.status >= 500 ? `HTTP ${response.status}` : undefined,
        });

        if (response.ok) {
          delivered = { response, attempt };
          break;
        }
        lastError = `HTTP ${response.status}`;
        // 5xx on delivery: the payment exists; retry with the SAME proof.
        if (response.status >= 500 && attempt < maxAttempts) {
          this.emit("DELIVERY_RETRYING", `Step ${stepIndex + 1}: HTTP ${response.status} after payment — safe retry with identical proof (no new broadcast).`);
          continue;
        }
        if (response.status === 402) {
          const code = response.headers.get("x-x402-error") ?? "unknown";
          lastError = `server rejected proof: ${code}`;
          this.emit("DELIVERY_RETRYING", `Step ${stepIndex + 1}: ${lastError} — proof may not be visible yet; retrying with the same proof.`);
          continue;
        }
        break;
      }

      if (!delivered) {
        state.transition("DELIVERY_FAILED");
        const failedEntry = newJournalEntry({
          intentId,
          taskRunId: task.taskRunId,
          stepIndex,
          endpointUrl: url,
          resourceHash,
          priceRaw,
          state: "DELIVERY_FAILED",
          now: this.nowFn,
        });
        failedEntry.txHash = paymentPayload.txHash;
        failedEntry.paymentPayload = paymentPayload;
        await this.journal.record(failedEntry);
        this.emit("DELIVERY_FAILED", `Step ${stepIndex + 1}: delivery failed after ${maxAttempts} attempts (${lastError}). Payment stands; data not claimed. Recovery is possible by re-running: the WAL already holds intent -> tx.`);
        continue;
      }

      // ---- Phase 5: verify PAYMENT-RESPONSE before trusting the data ----------
      let verificationMessage = "";
      try {
        verificationMessage = verifyDeliveryResponse(delivered.response, paymentPayload, network);
      } catch (e) {
        this.emit("COMMITMENT_VERIFIED", `Step ${stepIndex + 1}: PAYMENT-RESPONSE verification warning — ${String(e)}`);
      }
      let body: { data?: unknown; paidWith?: { replay?: boolean; txHash?: string } } = {};
      try {
        body = (await delivered.response.json()) as typeof body;
      } catch {
        body = {};
      }
      const replay = body.paidWith?.replay ?? false;
      state.transition("DELIVERED_200");
      // Journal follow-up: mark the intent fully delivered (crash-recovery no longer needed).
      const deliveredEntry = newJournalEntry({
        intentId,
        taskRunId: task.taskRunId,
        stepIndex,
        endpointUrl: url,
        resourceHash,
        priceRaw,
        state: "DELIVERED_200",
        now: this.nowFn,
      });
      deliveredEntry.txHash = paymentPayload.txHash;
      deliveredEntry.paymentPayload = paymentPayload;
      await this.journal.record(deliveredEntry);
      if (replay || delivered.attempt > 1) {
        const snap = this.deps.governor.snapshot();
        this.deps.ledger.recordRetryDelivered({
          stepIndex,
          intentId,
          endpointUrl: url,
          endpointLabel: label,
          whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
          priceRaw,
          txHash: paymentPayload.txHash,
          blockNumber: settledBlockNumber,
          attempt: delivered.attempt,
          replay,
          runningTotalRaw: snap.committedSpendRaw,
          remainingBudgetRaw: snap.remainingBudgetRaw,
          settlementCommitment: paymentPayload.settlementCommitment,
          now: this.nowFn,
        });
      }
      this.emit(replay ? "IDEMPOTENT_REPLAY_ACCEPTED" : "COMMITMENT_VERIFIED", `Step ${stepIndex + 1}: HTTP 200 — ${replay ? "server-side idempotent replay accepted (no double charge)" : "fresh settlement verified"}${verificationMessage ? ` (${verificationMessage})` : ""}.`);
      this.emit("DELIVERED_200", `Step ${stepIndex + 1}: delivered "${catalogWhat(this.deps.valueCatalog, url) ?? challenge.description}".`);

      purchases.push({
        stepIndex,
        endpointUrl: url,
        label,
        whatItBought: catalogWhat(this.deps.valueCatalog, url) ?? challenge.description,
        priceRaw,
        priceUSDC: formatUsdc(priceRaw),
        intentId,
        txHash: paymentPayload.txHash,
        blockNumber: settledBlockNumber,
        explorerUrl: explorerTxUrl(paymentPayload.txHash, this.deps.explorerBase),
        attempt: delivered.attempt,
        serverReplay: replay,
        quoteCommitment: paymentPayload.quoteCommitment,
        settlementCommitment: paymentPayload.settlementCommitment,
        data: body.data ?? null,
      });
    }

    // ---- Final status + synthesis --------------------------------------------
    const budgetRefusals = refusals.filter((r) => r.code === "REFUSED_OVER_TOTAL_BUDGET" || r.code === "REFUSED_OVER_PER_CALL_CAP");
    const status: TaskStatus =
      budgetRefusals.length > 0 && purchases.length < task.steps.length
        ? "HALTED_BUDGET_EXCEEDED"
        : purchases.length === task.steps.length
          ? "COMPLETED"
          : purchases.length > 0
            ? "COMPLETED_WITH_PARTIAL_DATA"
            : "FAILED_NO_PURCHASES";

    const snap = this.deps.governor.snapshot();
    const synthesis =
      task.synthesis?.(purchases, refusals) ??
      defaultSynthesis(task.title, purchases, refusals, status);
    this.emit("SYNTHESIS_READY", `Synthesis ready (${purchases.length} purchased, ${refusals.length} refused).`);
    const finishedAt = this.nowFn().toISOString();
    this.emit(
      status === "HALTED_BUDGET_EXCEEDED" ? "TASK_HALTED" : "TASK_COMPLETED",
      `Task "${task.title}" ${status} — spent ${formatUsdc(snap.committedSpendRaw)} of ${formatUsdc(task.totalBudgetRaw)} USDC (remaining ${formatUsdc(snap.remainingBudgetRaw)}).`,
    );

    return {
      taskRunId: task.taskRunId,
      title: task.title,
      description: task.description,
      status,
      mode: this.deps.mode ?? "live",
      purchases,
      refusals,
      ledger: [...this.deps.ledger.entriesSnapshot()],
      gauges: {
        totalBudgetUSDC: formatUsdc(snap.totalBudgetRaw),
        perCallCapUSDC: formatUsdc(snap.perCallCapRaw),
        committedSpendUSDC: formatUsdc(snap.committedSpendRaw),
        reservedSpendUSDC: formatUsdc(snap.reservedSpendRaw),
        runningTotalUSDC: formatUsdc(snap.runningTotalRaw),
        remainingBudgetUSDC: formatUsdc(snap.remainingBudgetRaw),
      },
      events: [...this.events],
      headerLog: [...this.headerLog],
      broadcasts: { attempted: this.broadcastsAttempted, skippedViaJournal: this.broadcastsSkippedViaJournal },
      faultsInjected: this.faults.fired.length,
      startedAt,
      finishedAt,
      synthesis,
    };
  }

  // --- internals -----------------------------------------------------------------

  private emit(type: AgentEventType, message: string, data?: Record<string, unknown>): void {
    this.events.push({ seq: ++this.eventSeq, at: this.nowFn().toISOString(), type, message, data });
  }

  private async fetchRecording(
    url: string,
    phase: "initial" | "delivery",
    attempt: number,
    extraHeaders: Record<string, string>,
    stepLog: StepHeaderLog,
    signatureSent?: string,
  ): Promise<Response> {
    // For the initial phase, fault injection happens before we record anything.
    if (phase === "initial") {
      const injected = this.faults.apply(url, "initial_request", attempt);
      if (injected === "network_error") throw new SimulatedNetworkError("drop_connection", url, attempt);
      if (injected) return injected;
    }
    const doFetch = this.deps.fetchFn ?? fetch;
    try {
      const res = await doFetch(url, { headers: { accept: "application/json", ...extraHeaders } });
      if (phase === "initial") {
        stepLog.exchanges.push({
          phase,
          attempt,
          requestHeaders: { ...extraHeaders },
          responseStatus: res.status,
          responseHeaders: Object.fromEntries(res.headers.entries()),
          rawPaymentRequiredHeader: res.headers.get(PAYMENT_REQUIRED_HEADER) ?? undefined,
        });
      }
      return res;
    } catch (e) {
      if (phase === "initial") {
        stepLog.exchanges.push({
          phase,
          attempt,
          requestHeaders: { ...extraHeaders },
          responseStatus: 0,
          responseHeaders: {},
          error: String(e),
        });
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}

// --- helpers --------------------------------------------------------------------

function resolveStepUrl(baseUrl: string, step: TaskStep): string {
  if (step.endpointUrl.startsWith("http://") || step.endpointUrl.startsWith("https://")) return step.endpointUrl;
  return `${baseUrl.replace(/\/$/, "")}${step.endpointUrl}`;
}

function catalogLabel(catalog: Record<string, CatalogEntry> | undefined, url: string): string | null {
  return catalog?.[url]?.label ?? null;
}

function catalogWhat(catalog: Record<string, CatalogEntry> | undefined, url: string): string | null {
  return catalog?.[url]?.description ?? null;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}...${hash.slice(-6)}`;
}

function mkRefusal(
  stepIndex: number,
  url: string,
  label: string,
  code: RefusalCode | "BROADCAST_FAILED",
  message: string,
  priceRaw: bigint,
  roi?: RoiEvaluation,
  whatItBought?: string | null,
): RefusalRecord {
  return {
    stepIndex,
    endpointUrl: url,
    label,
    whatItBought: whatItBought ?? "(unknown endpoint)",
    priceRaw,
    priceUSDC: formatUsdc(priceRaw),
    code,
    message,
    roi,
  };
}

export function defaultSynthesis(
  title: string,
  purchases: PurchaseRecord[],
  refusals: RefusalRecord[],
  status: TaskStatus,
): Record<string, unknown> {
  return {
    report: `${title} — ${status.replace(/_/g, " ")}`,
    purchasedSignals: purchases.map((p) => ({ endpoint: p.label, data: p.data })),
    refusedCalls: refusals.map((r) => ({ endpoint: r.label, code: r.code, reason: r.message })),
    generatedAt: new Date().toISOString(),
    digest: keccak256(stringToHex(`${title}|${purchases.map((p) => p.txHash).join(",")}|${status}`)),
  };
}
