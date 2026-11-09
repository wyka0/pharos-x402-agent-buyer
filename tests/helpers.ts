/**
 * Shared test harness: an in-process x402 world.
 *
 * - Real EIP-3009 signing (burner key, no funds needed)
 * - Real header encode/decode and verifier logic
 * - Settlements land in a SimulatedChain read by the prober — the full
 *   verify pipeline runs end-to-end without any network.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { SimulatedChain, createSimulatedBroadcastAdapter } from "@/lib/settlement/broadcast";
import { PaymentVerifier, InMemoryReceiptStore } from "@/lib/server/verifier";
import { getSpecByPath, ENDPOINT_SPECS } from "@/lib/server/catalog";
import { buildChallenge } from "@/lib/server/challenge";
import { serveX402 } from "@/lib/server/x402Endpoint";
import { BuyerAgent, type TaskResult, type AgentTask } from "@/lib/agent/buyer";
import { BudgetGovernor } from "@/lib/budget";
import { PaymentLedger } from "@/lib/ledger";
import { InMemoryJournal, type WriteAheadJournal } from "@/lib/idempotency";
import { valueCatalogFor } from "@/lib/agent/factory";
import { buildAuthorization, signAuthorization } from "@/lib/settlement/signer";
import { bindSettlement, computeIntentId, computeResourceHash } from "@/lib/commitment";
import { NETWORK_ID, CHAIN_ID } from "@/lib/chain";
import type { TxProber } from "@/lib/settlement/receipt";
import type { CatalogEntry } from "@/lib/roi";
import type { X402PaymentPayload, X402PaymentRequirements } from "@/lib/x402";

export const BASE = "http://test.local";
export const PAYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
export const PAY_TO = "0xB0f7681668f916eEd97dA066D31aA295D34727c0" as const;
export const USDC = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B" as const;

export interface WorldOptions {
  receipts?: InMemoryReceiptStore;
  proberOverride?: TxProber;
}

export function makeWorld(opts: WorldOptions = {}) {
  const sim = new SimulatedChain();
  const account = privateKeyToAccount(PAYER_KEY);
  const receipts = opts.receipts ?? new InMemoryReceiptStore();

  const prober: TxProber =
    opts.proberOverride ??
    {
      name: "test-sim-prober",
      async chainId() {
        return CHAIN_ID;
      },
      async getPaymentProof(txHash: Hex) {
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

  const verifier = new PaymentVerifier({
    prober,
    receipts,
    payTo: PAY_TO,
    asset: USDC,
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    verifierName: "test-verifier",
  });

  const broadcaster = createSimulatedBroadcastAdapter({ chain: sim, payer: account.address, usdc: USDC });

  const dispatch = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const spec = getSpecByPath(path);
    if (!spec) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return serveX402(req, {
      spec,
      verifierFor: () => verifier,
      network: NETWORK_ID,
      chainId: CHAIN_ID,
      asset: USDC,
      payTo: PAY_TO,
    });
  };

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return dispatch(new Request(String(input), init));
  }) as typeof fetch;

  return { sim, account, receipts, prober, verifier, broadcaster, fetchFn, dispatch };
}

export interface AgentOptions {
  baseUrl?: string;
  taskRunId?: string;
  faultRules?: ConstructorParameters<typeof BuyerAgent>[0]["faultRules"];
  journal?: WriteAheadJournal;
  fetchFn?: typeof fetch;
  broadcaster?: ConstructorParameters<typeof BuyerAgent>[0]["broadcaster"];
  signer?: ConstructorParameters<typeof BuyerAgent>[0]["signer"];
  governor?: BudgetGovernor;
  maxDeliveryAttempts?: number;
  dryRun?: boolean;
}

export function makeAgent(
  world: ReturnType<typeof makeWorld>,
  task: AgentTask,
  opts: AgentOptions = {},
): { agent: BuyerAgent; governor: BudgetGovernor; ledger: PaymentLedger; journal: WriteAheadJournal } {
  const journal = opts.journal ?? new InMemoryJournal();
  const governor =
    opts.governor ?? new BudgetGovernor({ totalBudgetRaw: task.totalBudgetRaw, perCallCapRaw: task.perCallCapRaw, id: task.taskRunId });
  const ledger = new PaymentLedger(task.taskRunId, task.totalBudgetRaw, task.perCallCapRaw);
  const account = privateKeyToAccount(PAYER_KEY);
  const agent = new BuyerAgent({
    governor,
    ledger,
    journal,
    broadcaster: opts.broadcaster ?? world.broadcaster,
    signer: opts.signer ?? { address: account.address, signTypedData: (td) => account.signTypedData(td) },
    valueCatalog: valueCatalogFor(opts.baseUrl ?? BASE),
    fetchFn: opts.fetchFn ?? world.fetchFn,
    faultRules: opts.faultRules,
    maxDeliveryAttempts: opts.maxDeliveryAttempts,
    dryRun: opts.dryRun,
    mode: "simulated",
  });
  return { agent, governor, ledger, journal };
}

export function catalogFor(baseUrl: string = BASE): Record<string, CatalogEntry> {
  return valueCatalogFor(baseUrl);
}

export const SPECS = ENDPOINT_SPECS;
export type { TaskResult };

/**
 * Builds a fully valid, signed, settled x402 payment payload for a catalog
 * endpoint against the world's simulated chain — the same flow the agent runs.
 */
export async function buildPaidPayload(
  world: ReturnType<typeof makeWorld>,
  path: string,
  opts: { intentSeed?: string; stepIndex?: number } = {},
): Promise<{ payload: X402PaymentPayload; requirements: X402PaymentRequirements; intentId: Hex }> {
  const spec = getSpecByPath(path);
  if (!spec) throw new Error(`no spec for ${path}`);
  const resource = `${BASE}${path}`;
  const challenge = buildChallenge({ resource, spec, network: NETWORK_ID, chainId: CHAIN_ID, asset: USDC, payTo: PAY_TO });
  const requirements = challenge.requirements;
  const price = BigInt(requirements.maxAmountRequired);
  const resourceHash = computeResourceHash(resource, requirements.maxAmountRequired, PAY_TO);
  const intentId = computeIntentId(opts.intentSeed ?? "harness", resource, opts.stepIndex ?? 0, resourceHash);
  const authorization = buildAuthorization({
    payer: world.account.address,
    payTo: PAY_TO,
    amountRaw: price,
    intentId,
    nowSec: Math.floor(Date.now() / 1000),
  });
  const signature = await signAuthorization({ address: world.account.address, signTypedData: (td) => world.account.signTypedData(td) }, authorization, USDC);
  const broadcast = await world.broadcaster.broadcastTransferWithAuthorization({ authorization, signature, intentId });
  const payload: X402PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK_ID,
    resource,
    requirementsEcho: requirements,
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
    txHash: broadcast.txHash,
    quoteCommitment: requirements.extra.quoteCommitment,
    settlementCommitment: bindSettlement(requirements.extra.quoteCommitment, broadcast.txHash),
  };
  return { payload, requirements, intentId };
}
