/**
 * BuyerAgent factory shared by the API routes and scripts/verify-onchain.ts.
 * Selects signer + broadcaster per mode:
 *  - "live":      env key -> real EIP-3009 settlement on Pharos Atlantic
 *  - "simulated": real EIP-3009 signing (burner/fallback key) + SimulatedChain
 *                 settlement; identical protocol, zero tokens moved.
 */
import { privateKeyToAccount } from "viem/accounts";
import { payerKeyFromEnv, usdcAddressFromEnv, explorerUrlFromEnv, rpcUrlFromEnv, pharosAtlantic } from "../chain";
import { AGENT_VALUE_CATALOG } from "../server/catalog";
import { BudgetGovernor } from "../budget";
import { PaymentLedger } from "../ledger";
import { InMemoryJournal, type WriteAheadJournal } from "../idempotency";
import { createSimulatedBroadcastAdapter, createViemBroadcastAdapter, type BroadcastAdapter } from "../settlement/broadcast";
import { signAuthorization, type SignerLike } from "../settlement/signer";
import type { CatalogEntry } from "../roi";
import { BuyerAgent, type BuyerAgentDeps, type AgentTask, type TaskResult } from "./buyer";
import { demoAFaultRules, buildDemoTaskA, buildDemoTaskB, buildSmartRoiTask } from "./tasks";
import type { FaultRule } from "./faults";

/** Burner key used ONLY for simulated-mode signing (never holds funds). */
const SIMULATION_SIGNER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

let sharedJournal: WriteAheadJournal | null = null;
export function sharedInMemoryJournal(): WriteAheadJournal {
  if (!sharedJournal) sharedJournal = new InMemoryJournal();
  return sharedJournal;
}

export function valueCatalogFor(baseUrl: string): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (const [path, entry] of Object.entries(AGENT_VALUE_CATALOG)) {
    out[`${baseUrl.replace(/\/$/, "")}${path}`] = { ...entry, endpointUrl: `${baseUrl.replace(/$/, "")}${path}` };
  }
  return out;
}

export interface AgentRuntimeConfig {
  mode: "live" | "simulated";
  faultRules?: FaultRule[];
  journal?: WriteAheadJournal;
  maxDeliveryAttempts?: number;
  dryRun?: boolean;
}

export function createSigner(mode: "live" | "simulated"): { signer: SignerLike; address: `0x${string}` } {
  if (mode === "live") {
    const key = payerKeyFromEnv();
    if (!key) {
      throw new Error(
        "Live settlement requires TEST_USER_PRIVATE_KEY in .env.local. Use mode=simulated for the zero-risk demo.",
      );
    }
    const account = privateKeyToAccount(key);
    return {
      signer: { address: account.address, signTypedData: (td) => account.signTypedData(td) },
      address: account.address,
    };
  }
  const envKey = payerKeyFromEnv();
  const account = privateKeyToAccount(envKey ?? SIMULATION_SIGNER_KEY);
  return {
    signer: { address: account.address, signTypedData: (td) => account.signTypedData(td) },
    address: account.address,
  };
}

export function createBroadcaster(mode: "live" | "simulated", payer: `0x${string}`): BroadcastAdapter {
  if (mode === "live") {
    return createViemBroadcastAdapter({ rpcUrl: rpcUrlFromEnv(), chain: pharosAtlantic(rpcUrlFromEnv()) });
  }
  return createSimulatedBroadcastAdapter({ payer, usdc: usdcAddressFromEnv() });
}

export function createBuyerAgent(task: AgentTask, cfg: AgentRuntimeConfig): BuyerAgent {
  const { signer } = createSigner(cfg.mode);
  const broadcaster = createBroadcaster(cfg.mode, signer.address);
  const deps: BuyerAgentDeps = {
    governor: new BudgetGovernor({
      totalBudgetRaw: task.totalBudgetRaw,
      perCallCapRaw: task.perCallCapRaw,
      id: task.taskRunId,
    }),
    ledger: new PaymentLedger(task.taskRunId, task.totalBudgetRaw, task.perCallCapRaw),
    journal: cfg.journal ?? sharedInMemoryJournal(),
    broadcaster,
    signer,
    valueCatalog: valueCatalogFor(task.baseUrl),
    faultRules: cfg.faultRules,
    maxDeliveryAttempts: cfg.maxDeliveryAttempts ?? 3,
    explorerBase: explorerUrlFromEnv(),
    mode: cfg.mode,
    dryRun: cfg.dryRun,
  };
  return new BuyerAgent(deps);
}

export interface RunOptions {
  baseUrl: string;
  mode?: "live" | "simulated";
  faults?: boolean;
  taskRunId?: string;
  journal?: WriteAheadJournal;
  maxDeliveryAttempts?: number;
}

export type TaskKind = "A" | "B" | "SMART";

export function buildTask(kind: TaskKind, opts: RunOptions): AgentTask {
  switch (kind) {
    case "A":
      return buildDemoTaskA(opts.baseUrl, opts.taskRunId);
    case "B":
      return buildDemoTaskB(opts.baseUrl, opts.taskRunId);
    case "SMART":
      return buildSmartRoiTask(opts.baseUrl, opts.taskRunId);
  }
}

export function faultRulesFor(kind: TaskKind, faults?: boolean): FaultRule[] | undefined {
  if (faults === false) return undefined;
  if (kind === "A") return demoAFaultRules();
  return undefined;
}

export async function runPrebuiltTask(kind: TaskKind, opts: RunOptions): Promise<TaskResult> {
  const mode = opts.mode ?? "simulated";
  const task = buildTask(kind, opts);
  const agent = createBuyerAgent(task, {
    mode,
    faultRules: faultRulesFor(kind, opts.faults),
    journal: opts.journal,
    maxDeliveryAttempts: opts.maxDeliveryAttempts,
  });
  return agent.runTask(task);
}

export { signAuthorization };
