import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryJournal,
  FileJournal,
  PaymentStateMachine,
  IllegalTransitionError,
  newJournalEntry,
  recoverSettledIntents,
  type JournalEntry,
} from "@/lib/idempotency";
import { computeIntentId, computeResourceHash } from "@/lib/commitment";
import { keccak256, stringToHex, type Hex } from "viem";

const intent = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;
const hash = (n: number) => ("0x" + (n + 7).toString(16).padStart(64, "0")) as Hex;

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    intentId: intent(1),
    taskRunId: "run-1",
    stepIndex: 0,
    endpointUrl: "http://test.local/api/x402/security-audit",
    resourceHash: computeResourceHash("http://test.local/api/x402/security-audit", "100000", "0xB0f7681668f916eEd97dA066D31aA295D34727c0"),
    priceRaw: "100000",
    state: "PAYMENT_BROADCASTED",
    txHash: hash(1),
    updatedAt: new Date().toISOString(),
    revisions: 0,
    ...overrides,
  };
}

describe("Requirement 04: intentId determinism", () => {
  it("produces identical intentIds for identical task inputs", () => {
    const rh = computeResourceHash("http://test.local/api/x402/whale-telemetry", "150000", "0xB0f7681668f916eEd97dA066D31aA295D34727c0");
    const a = computeIntentId("task-run-abc", "http://test.local/api/x402/whale-telemetry", 1, rh);
    const b = computeIntentId("task-run-abc", "http://test.local/api/x402/whale-telemetry", 1, rh);
    expect(a).toBe(b);
  });

  it("diverges the intentId when any component changes", () => {
    const rh = computeResourceHash("http://test.local/api/x402/whale-telemetry", "150000", "0xB0f7681668f916eEd97dA066D31aA295D34727c0");
    const base = computeIntentId("run", "http://test.local/x", 0, rh);
    expect(computeIntentId("run2", "http://test.local/x", 0, rh)).not.toBe(base);
    expect(computeIntentId("run", "http://test.local/y", 0, rh)).not.toBe(base);
    expect(computeIntentId("run", "http://test.local/x", 1, rh)).not.toBe(base);
    expect(computeIntentId("run", "http://test.local/x", 0, computeResourceHash("http://test.local/x", "150001", "0xB0f7681668f916eEd97dA066D31aA295D34727c0"))).not.toBe(base);
  });

  it("produces valid 32-byte hex ids", () => {
    const id = computeIntentId("run", "http://test.local/x", 0, keccak256(stringToHex("rh")) as Hex);
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("Requirement 04: payment state machine", () => {
  it("follows the legal happy path QUOTED_402 -> ... -> DELIVERED_200", () => {
    const sm = new PaymentStateMachine(intent(1));
    expect(sm.current).toBe("QUOTED_402");
    sm.transition("PAYMENT_BROADCASTING");
    sm.transition("PAYMENT_BROADCASTED");
    sm.transition("DELIVERY_PENDING");
    sm.transition("DELIVERED_200");
    expect(sm.current).toBe("DELIVERED_200");
    expect(sm.isTerminal()).toBe(true);
    expect(sm.history).toHaveLength(4);
  });

  it("records timestamps and notes on every transition", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("PAYMENT_BROADCASTING", "pre-record");
    const t = sm.history[0];
    expect(t.from).toBe("QUOTED_402");
    expect(t.to).toBe("PAYMENT_BROADCASTING");
    expect(t.note).toBe("pre-record");
    expect(new Date(t.at).getTime()).not.toBeNaN();
  });

  it("supports safe delivery retries from DELIVERY_FAILED", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("PAYMENT_BROADCASTING");
    sm.transition("PAYMENT_BROADCASTED");
    sm.transition("DELIVERY_PENDING");
    sm.transition("DELIVERY_FAILED");
    sm.retryDelivery();
    expect(sm.current).toBe("DELIVERY_PENDING");
    sm.transition("DELIVERED_200");
    expect(sm.isTerminal()).toBe(true);
  });

  it("allows BROADCAST_FAILED -> QUOTED_402 (funds definitely not moved)", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("PAYMENT_BROADCASTING");
    sm.transition("BROADCAST_FAILED");
    sm.transition("QUOTED_402");
    expect(sm.current).toBe("QUOTED_402");
  });

  it("throws IllegalTransitionError for skipping states", () => {
    const sm = new PaymentStateMachine(intent(1));
    expect(() => sm.transition("DELIVERED_200")).toThrow(IllegalTransitionError);
    expect(() => sm.transition("DELIVERY_PENDING")).toThrow(IllegalTransitionError);
  });

  it("forbids paying twice from QUOTED_402 after terminal refusal", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("REFUSED_OVER_PER_CALL_CAP");
    expect(() => sm.transition("PAYMENT_BROADCASTING")).toThrow(IllegalTransitionError);
    expect(sm.isTerminal()).toBe(true);
  });

  it("forbids transitioning out of DELIVERED_200 (terminal)", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("PAYMENT_BROADCASTING");
    sm.transition("PAYMENT_BROADCASTED");
    sm.transition("DELIVERY_PENDING");
    sm.transition("DELIVERED_200");
    expect(() => sm.transition("DELIVERY_PENDING")).toThrow(IllegalTransitionError);
    expect(() => sm.transition("PAYMENT_BROADCASTING")).toThrow(IllegalTransitionError);
  });

  it("forbids DELIVERED_200 directly from PAYMENT_BROADCASTED", () => {
    const sm = new PaymentStateMachine(intent(1));
    sm.transition("PAYMENT_BROADCASTING");
    sm.transition("PAYMENT_BROADCASTED");
    expect(() => sm.transition("DELIVERED_200")).toThrow(IllegalTransitionError);
  });
});

describe("Requirement 04 / Innovation #3: Write-Ahead Journal (in-memory)", () => {
  it("records and looks up entries by intentId", async () => {
    const j = new InMemoryJournal();
    await j.record(entry({ intentId: intent(1), txHash: hash(1) }));
    const found = await j.lookup(intent(1));
    expect(found).not.toBeNull();
    expect(found!.txHash).toBe(hash(1));
    expect(await j.lookup(intent(99))).toBeNull();
  });

  it("upserts: later records overwrite and bump revisions", async () => {
    const j = new InMemoryJournal();
    await j.record(entry({ intentId: intent(1), state: "PAYMENT_BROADCASTING" }));
    await j.record(entry({ intentId: intent(1), state: "PAYMENT_BROADCASTED", txHash: hash(1) }));
    const found = await j.lookup(intent(1));
    expect(found!.state).toBe("PAYMENT_BROADCASTED");
    expect(found!.revisions).toBe(2);
    await j.record(entry({ intentId: intent(1), state: "DELIVERY_PENDING" }));
    expect((await j.lookup(intent(1)))!.revisions).toBe(3);
  });

  it("returns defensive copies from lookup/list", async () => {
    const j = new InMemoryJournal();
    await j.record(entry());
    const found = await j.lookup(intent(1));
    found!.txHash = hash(99);
    expect((await j.lookup(intent(1)))!.txHash).toBe(hash(1));
  });

  it("lists every entry across intents", async () => {
    const j = new InMemoryJournal();
    await j.record(entry({ intentId: intent(1) }));
    await j.record(entry({ intentId: intent(2) }));
    await j.record(entry({ intentId: intent(3) }));
    expect(await j.list()).toHaveLength(3);
  });
});

describe("Innovation #3: FileJournal (durable WAL)", () => {
  it("persists entries across instances (crash recovery)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-wal-"));
    const path = join(dir, "wal", "journal.json");
    const j1 = new FileJournal(path);
    await j1.record(entry({ intentId: intent(5), txHash: hash(5), state: "PAYMENT_BROADCASTED" }));
    await j1.record(entry({ intentId: intent(6), state: "PAYMENT_BROADCASTING" }));

    // "Crash": a brand-new instance reads the same file
    const j2 = new FileJournal(path);
    const recovered5 = await j2.lookup(intent(5));
    const recovered6 = await j2.lookup(intent(6));
    expect(recovered5?.txHash).toBe(hash(5));
    expect(recovered6?.state).toBe("PAYMENT_BROADCASTING");

    const raw = await readFile(path, "utf8");
    expect(raw).toContain("\"entries\"");
    await rm(dir, { recursive: true, force: true });
  });

  it("compacts: multiple updates of one intent produce one file record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-wal-"));
    const path = join(dir, "journal.json");
    const j = new FileJournal(path);
    await j.record(entry({ intentId: intent(1), state: "PAYMENT_BROADCASTING" }));
    await j.record(entry({ intentId: intent(1), state: "PAYMENT_BROADCASTED", txHash: hash(1) }));
    await j.record(entry({ intentId: intent(1), state: "DELIVERY_PENDING" }));
    const raw = JSON.parse(await readFile(path, "utf8")) as { entries: JournalEntry[] };
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].state).toBe("DELIVERY_PENDING");
    expect(raw.entries[0].revisions).toBe(3);
    await rm(dir, { recursive: true, force: true });
  });

  it("handles a missing/corrupt file gracefully", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-wal-"));
    const j = new FileJournal(join(dir, "nonexistent", "journal.json"));
    expect(await j.lookup(intent(1))).toBeNull();
    expect(await j.list()).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("supports concurrent record calls without file corruption", async () => {
    const dir = await mkdtemp(join(tmpdir(), "x402-wal-"));
    const path = join(dir, "journal.json");
    const j = new FileJournal(path);
    await Promise.all(Array.from({ length: 10 }, (_, i) => j.record(entry({ intentId: intent(i), txHash: hash(i) }))));
    const list = await j.list();
    expect(list).toHaveLength(10);
    const j2 = new FileJournal(path);
    expect(await j2.list()).toHaveLength(10);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("Innovation #3: crash recovery via recoverSettledIntents", () => {
  it("recovers only intents that have an on-chain txHash", async () => {
    const j = new InMemoryJournal();
    await j.record(entry({ intentId: intent(1), state: "PAYMENT_BROADCASTED", txHash: hash(1) }));
    await j.record(entry({ intentId: intent(2), state: "PAYMENT_BROADCASTING" })); // pre-record, no tx yet
    await j.record(entry({ intentId: intent(3), state: "DELIVERY_PENDING", txHash: hash(3) }));
    await j.record(entry({ intentId: intent(4), state: "DELIVERY_FAILED", txHash: hash(4) }));
    const recovered = await recoverSettledIntents(j);
    expect([...recovered.keys()].sort()).toEqual([intent(1), intent(3), intent(4)].sort());
    expect(recovered.has(intent(2))).toBe(false);
  });

  it("an empty journal recovers nothing", async () => {
    const recovered = await recoverSettledIntents(new InMemoryJournal());
    expect(recovered.size).toBe(0);
  });
});

describe("Journal entry factory", () => {
  it("creates entries with decimal-string prices and fresh timestamps", () => {
    const e = newJournalEntry({
      intentId: intent(1),
      taskRunId: "run",
      stepIndex: 2,
      endpointUrl: "http://x",
      resourceHash: keccak256(stringToHex("rh")) as Hex,
      priceRaw: 150_000n,
      state: "QUOTED_402",
    });
    expect(e.priceRaw).toBe("150000");
    expect(e.state).toBe("QUOTED_402");
    expect(e.txHash).toBeUndefined();
    expect(e.revisions).toBe(0);
  });
});
