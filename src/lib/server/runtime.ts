/**
 * Server runtime singletons: verifier + prober + endpoint deps, per mode.
 *  - "live":      real viem RPC prober against Pharos Atlantic (receipts via env store)
 *  - "simulated": shared SimulatedChain prober (zero-risk demo mode)
 */
import { usdcAddressFromEnv, payToFromEnv, rpcUrlFromEnv, NETWORK_ID, CHAIN_ID } from "../chain";
import { createViemTxProber, type TxProber } from "../settlement/receipt";
import { sharedSimulatedChain } from "../settlement/broadcast";
import { PaymentVerifier, InMemoryReceiptStore, type ReceiptStore, type SettlementRecord } from "./verifier";
import { ENDPOINT_SPECS, type EndpointPath } from "./catalog";
import type { ServeX402Deps } from "./x402Endpoint";
import { FileJournal } from "../idempotency";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

export type RuntimeMode = "live" | "simulated";

let liveVerifier: PaymentVerifier | null = null;
let simulatedVerifier: PaymentVerifier | null = null;

// --- optional file-backed receipt store ----------------------------------------

class FileReceiptStore {
  private mem = new InMemoryReceiptStore();
  private loaded = false;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.path, "utf8");
      const records = JSON.parse(raw) as SettlementRecord[];
      for (const r of records) this.mem.put(r);
    } catch {
      // first boot
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.mem.all(), null, 2), "utf8");
  }

  async get(intentId: Parameters<ReceiptStore["get"]>[0]): Promise<SettlementRecord | undefined> {
    await this.load();
    return this.mem.get(intentId);
  }
  async getByNonce(nonce: Parameters<ReceiptStore["getByNonce"]>[0]): Promise<SettlementRecord | undefined> {
    await this.load();
    return this.mem.getByNonce(nonce);
  }
  async put(record: SettlementRecord): Promise<void> {
    await this.load();
    this.mem.put(record);
    await this.persist();
  }
  async all(): Promise<SettlementRecord[]> {
    await this.load();
    return this.mem.all();
  }
}

// The PaymentVerifier uses the sync ReceiptStore interface; the file store wraps
// it with a synchronous facade persisted asynchronously (fire-and-forget).
function fileStoreSyncFacade(path: string): ReceiptStore {
  const file = new FileReceiptStore(path);
  const mem = new InMemoryReceiptStore();
  void (async () => {
    const records = await file.all();
    for (const r of records) mem.put(r);
  })();
  return {
    get: (intentId) => mem.get(intentId),
    getByNonce: (nonce) => mem.getByNonce(nonce),
    put: (record) => {
      mem.put(record);
      void file.put(record).catch(() => undefined);
    },
    all: () => mem.all(),
  };
}

function receiptStore(): ReceiptStore {
  if (process.env.X402_RECEIPT_STORE === "file") {
    return fileStoreSyncFacade(join(process.cwd(), ".data", "receipts.json"));
  }
  return new InMemoryReceiptStore();
}

export function getVerifier(mode: RuntimeMode): PaymentVerifier {  if (mode === "live") {
    if (!liveVerifier) {
      const prober: TxProber = createViemTxProber({ rpcUrl: rpcUrlFromEnv(), usdcAddress: usdcAddressFromEnv() });
      liveVerifier = new PaymentVerifier({
        prober,
        receipts: receiptStore(),
        payTo: payToFromEnv(),
        asset: usdcAddressFromEnv(),
        network: NETWORK_ID,
        chainId: CHAIN_ID,
        verifierName: "pharos-atlantic-live-verifier",
      });
    }
    return liveVerifier;
  }
  if (!simulatedVerifier) {
    const sim = sharedSimulatedChain();
    const prober: TxProber = {
      name: "simulated",
      async chainId() {
        return Number(CHAIN_ID);
      },
      async getPaymentProof(txHash) {
        const rec = sim.getProof(txHash);
        if (!rec) return null;
        return {
          status: rec.status,
          blockNumber: rec.blockNumber,
          token: rec.token,
          transfer: { from: rec.from, to: rec.to, value: rec.value },
        };
      },
    };
    simulatedVerifier = new PaymentVerifier({
      prober,
      receipts: new InMemoryReceiptStore(),
      payTo: payToFromEnv(),
      asset: usdcAddressFromEnv(),
      network: NETWORK_ID,
      chainId: CHAIN_ID,
      verifierName: "pharos-atlantic-simulated-verifier",
    });
  }
  return simulatedVerifier;
}

export function getEndpointDeps(path: EndpointPath): ServeX402Deps {
  return {
    spec: ENDPOINT_SPECS[path],
    verifierFor: (payload) => {
      // Auto-dispatch: a settlement registered in the shared SimulatedChain is a
      // simulated proof; anything else is verified against real Pharos Atlantic.
      const knownSimulated = sharedSimulatedChain().getProof(payload.txHash) !== null;
      return getVerifier(knownSimulated ? "simulated" : "live");
    },
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    asset: usdcAddressFromEnv(),
    payTo: payToFromEnv(),
  };
}

/** Shared WAL location for the live verify script (crash-recovery demo). */
export function defaultWALPath(): string {
  return join(process.cwd(), ".data", "wal", "journal.json");
}

export { FileJournal };
