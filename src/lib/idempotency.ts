/**
 * Requirement 04 / Innovation #3 — Idempotent payment engine primitives:
 * deterministic intent ids, payment state machine, and the Write-Ahead Journal.
 *
 * The WAL persists `intentId -> payment proof` BEFORE the HTTP re-submission, so
 * a crash mid-retry is recoverable: re-running the task finds the settled txHash
 * in the journal and claims the data without paying twice. The EIP-3009 nonce is
 * derived deterministically from the intentId, so even the "broadcast crashed
 * before journaling" window cannot double-settle: a second broadcast with the
 * same authorization reverts on-chain (nonce already consumed).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Hex, X402PaymentPayload } from "./x402";

// --- State machine -----------------------------------------------------------

export const PAYMENT_STATES = [
  "QUOTED_402",
  "PAYMENT_BROADCASTING",
  "PAYMENT_BROADCASTED",
  "DELIVERY_PENDING",
  "DELIVERED_200",
  "BROADCAST_FAILED",
  "DELIVERY_FAILED",
  "REFUSED_OVER_PER_CALL_CAP",
  "REFUSED_OVER_TOTAL_BUDGET",
  "REFUSED_LOW_UTILITY",
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

const TERMINAL_STATES: ReadonlySet<PaymentState> = new Set([
  "DELIVERED_200",
  "REFUSED_OVER_PER_CALL_CAP",
  "REFUSED_OVER_TOTAL_BUDGET",
  "REFUSED_LOW_UTILITY",
]);

const LEGAL_TRANSITIONS: Readonly<Record<PaymentState, readonly PaymentState[]>> = {
  QUOTED_402: ["PAYMENT_BROADCASTING", "BROADCAST_FAILED", "REFUSED_OVER_PER_CALL_CAP", "REFUSED_OVER_TOTAL_BUDGET", "REFUSED_LOW_UTILITY"],
  PAYMENT_BROADCASTING: ["PAYMENT_BROADCASTED", "BROADCAST_FAILED"],
  PAYMENT_BROADCASTED: ["DELIVERY_PENDING"],
  DELIVERY_PENDING: ["DELIVERED_200", "DELIVERY_FAILED"],
  DELIVERY_FAILED: ["DELIVERY_PENDING"], // safe retry with the SAME payment proof
  BROADCAST_FAILED: ["QUOTED_402"], // funds definitely not moved; agent may re-quote
  DELIVERED_200: [],
  REFUSED_OVER_PER_CALL_CAP: [],
  REFUSED_OVER_TOTAL_BUDGET: [],
  REFUSED_LOW_UTILITY: [],
};

export class IllegalTransitionError extends Error {
  constructor(readonly from: PaymentState, readonly to: PaymentState) {
    super(`Illegal payment state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export interface StateTransition {
  from: PaymentState;
  to: PaymentState;
  at: string; // ISO timestamp
  note?: string;
}

export class PaymentStateMachine {
  private _current: PaymentState;
  readonly history: StateTransition[] = [];

  constructor(readonly intentId: Hex, initial: PaymentState = "QUOTED_402", private readonly now: () => Date = () => new Date()) {
    this._current = initial;
  }

  get current(): PaymentState {
    return this._current;
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.has(this._current);
  }

  can(to: PaymentState): boolean {
    return LEGAL_TRANSITIONS[this._current].includes(to);
  }

  transition(to: PaymentState, note?: string): PaymentState {
    if (!this.can(to)) throw new IllegalTransitionError(this._current, to);
    const t: StateTransition = { from: this._current, to, at: this.now().toISOString(), note };
    this.history.push(t);
    this._current = to;
    return to;
  }

  /** Legal delivery retry: DELIVERY_FAILED -> DELIVERY_PENDING with the same proof. */
  retryDelivery(note?: string): void {
    this.transition("DELIVERY_PENDING", note ?? "safe retry with the same payment proof");
  }
}

// --- Write-ahead journal ------------------------------------------------------

export type JournalPaymentState = Extract<
  PaymentState,
  "QUOTED_402" | "PAYMENT_BROADCASTING" | "PAYMENT_BROADCASTED" | "DELIVERY_PENDING" | "DELIVERED_200" | "BROADCAST_FAILED" | "DELIVERY_FAILED"
>;

export interface JournalEntry {
  intentId: Hex;
  taskRunId: string;
  stepIndex: number;
  endpointUrl: string;
  resourceHash: Hex;
  priceRaw: string; // decimal string
  state: JournalPaymentState;
  /** Set as soon as the settlement tx exists — the atomic "already paid" marker. */
  txHash?: Hex;
  /** Full payment payload (signed + bound to txHash) for reuse on retries. */
  paymentPayload?: X402PaymentPayload;
  updatedAt: string;
  /** Number of times the journal entry was updated (audit trail size marker). */
  revisions: number;
}

export interface WriteAheadJournal {
  record(entry: JournalEntry): Promise<void>;
  lookup(intentId: Hex): Promise<JournalEntry | null>;
  list(): Promise<JournalEntry[]>;
}

export function newJournalEntry(params: {
  intentId: Hex;
  taskRunId: string;
  stepIndex: number;
  endpointUrl: string;
  resourceHash: Hex;
  priceRaw: bigint;
  state: JournalPaymentState;
  now?: () => Date;
}): JournalEntry {
  return {
    intentId: params.intentId,
    taskRunId: params.taskRunId,
    stepIndex: params.stepIndex,
    endpointUrl: params.endpointUrl,
    resourceHash: params.resourceHash,
    priceRaw: params.priceRaw.toString(),
    state: params.state,
    updatedAt: (params.now?.() ?? new Date()).toISOString(),
    revisions: 0,
  };
}

export class InMemoryJournal implements WriteAheadJournal {
  private readonly map = new Map<string, JournalEntry>();

  async record(entry: JournalEntry): Promise<void> {
    const existing = this.map.get(entry.intentId);
    const revisions = (existing?.revisions ?? entry.revisions) + 1;
    this.map.set(entry.intentId, { ...entry, revisions, updatedAt: new Date().toISOString() });
  }

  async lookup(intentId: Hex): Promise<JournalEntry | null> {
    const e = this.map.get(intentId);
    return e ? { ...e } : null;
  }

  async list(): Promise<JournalEntry[]> {
    return [...this.map.values()].map((e) => ({ ...e }));
  }
}

/**
 * File-backed WAL with atomic writes (tmp file + rename). One JSON document,
 * compacted on every record — intentionally simple, durable, and crash-safe for
 * single-process agents (the documented boundary: use a real DB for multi-writer
 * production deployments).
 */
export class FileJournal implements WriteAheadJournal {
  private cache: Map<string, JournalEntry> | null = null;
  private loadPromise: Promise<void> | null = null;
  private opQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async record(entry: JournalEntry): Promise<void> {
    // Serialize the full read-modify-write so concurrent records never corrupt
    // the cache (and each op waits for the previous one's flush).
    this.opQueue = this.opQueue.then(() => this.recordLocked(entry), () => this.recordLocked(entry));
    await this.opQueue;
  }

  private async recordLocked(entry: JournalEntry): Promise<void> {
    await this.load();
    const existing = this.cache!.get(entry.intentId);
    const revisions = (existing?.revisions ?? entry.revisions) + 1;
    this.cache!.set(entry.intentId, { ...entry, revisions, updatedAt: new Date().toISOString() });
    await this.flush();
  }

  async lookup(intentId: Hex): Promise<JournalEntry | null> {
    await this.load();
    const e = this.cache!.get(intentId);
    return e ? { ...e } : null;
  }

  async list(): Promise<JournalEntry[]> {
    await this.load();
    return [...this.cache!.values()].map((e) => ({ ...e }));
  }

  private load(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { entries?: JournalEntry[] };
      this.cache = new Map((parsed.entries ?? []).map((e) => [e.intentId, e]));
    } catch {
      this.cache = new Map();
    }
  }

  private async flush(): Promise<void> {
    const entries = [...this.cache!.values()];
    const doc = JSON.stringify({ version: 1, entries }, null, 2);
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = join(dirname(this.filePath), `.${randomUUID()}.tmp`);
    await writeFile(tmp, doc, "utf8");
    await rename(tmp, this.filePath);
  }
}

/**
 * Crash recovery: rebuild the set of intents that already have an on-chain
 * settlement attached. Re-running a task consults this first, so a crash after
 * broadcast but before delivery never leads to a second payment.
 */
export async function recoverSettledIntents(journal: WriteAheadJournal): Promise<Map<Hex, JournalEntry>> {
  const entries = await journal.list();
  const recovered = new Map<Hex, JournalEntry>();
  for (const e of entries) {
    if (e.txHash && (e.state === "PAYMENT_BROADCASTED" || e.state === "DELIVERY_PENDING" || e.state === "DELIVERY_FAILED" || e.state === "DELIVERED_200")) {
      recovered.set(e.intentId, e);
    }
  }
  return recovered;
}
