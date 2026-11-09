/**
 * Settlement broadcast adapters.
 *
 * - `createViemBroadcastAdapter` — real on-chain settlement on Pharos Atlantic:
 *   signs (see signer.ts) and broadcasts USDC `transferWithAuthorization`, then
 *   waits for the receipt. Optional plain-ERC-20 `transfer` fallback for
 *   testnets where the EIP-3009 canary fails.
 * - `createSimulatedBroadcastAdapter` — zero-risk demo mode: same interface,
 *   deterministic fake txHashes registered in a shared `SimulatedChain` so the
 *   server-side verifier can "confirm" them exactly like a real RPC would.
 * - `FacilitatorClient` — optional external facilitator adapter (/verify, /settle).
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  hexToSignature,
  encodeFunctionData,
  parseEventLogs,
  type Chain,
  type PublicClient,
  type WalletClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex, maxUint256, type Hex } from "viem";
import { pharosAtlantic, rpcUrlFromEnv, payerKeyFromEnv, usdcAddressFromEnv, CHAIN_ID } from "../chain";
import type { Eip3009Authorization, SignerLike } from "./signer";

export interface BroadcastResult {
  txHash: Hex;
  broadcastedAt: string;
  strategy: "eip3009" | "transfer";
}

export interface ReceiptResult {
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface BroadcastAdapter {
  readonly name: string;
  readonly broadcastCount: number;
  broadcastTransferWithAuthorization(params: {
    authorization: Eip3009Authorization;
    signature: Hex;
    intentId: Hex;
  }): Promise<BroadcastResult>;
  waitForReceipt(txHash: Hex): Promise<ReceiptResult>;
}

// --- Viem (real on-chain) -----------------------------------------------------

const USDC_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export interface ViemBroadcastOptions {
  rpcUrl?: string;
  chain?: Chain;
  payerPrivateKey?: `0x${string}`;
  usdcAddress?: `0x${string}`;
  /** Allow plain ERC-20 transfer fallback when EIP-3009 fails (testnet convenience). */
  allowTransferFallback?: boolean;
  receiptTimeoutMs?: number;
}

export function createViemBroadcastAdapter(opts: ViemBroadcastOptions = {}): BroadcastAdapter {
  const rpcUrl = opts.rpcUrl ?? rpcUrlFromEnv();
  const chain = opts.chain ?? pharosAtlantic(rpcUrl);
  const usdc = opts.usdcAddress ?? usdcAddressFromEnv();
  const key = opts.payerPrivateKey ?? payerKeyFromEnv();
  if (!key) throw new Error("createViemBroadcastAdapter: TEST_USER_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(key);
  const wallet: WalletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub: PublicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  let count = 0;

  return {
    name: "viem-live",
    get broadcastCount() {
      return count;
    },
    async broadcastTransferWithAuthorization({ authorization, signature }) {
      count += 1;
      const { v, r, s, yParity } = hexToSignature(signature);
      const vByte = Number(v ?? (yParity === 0 ? 27 : 28));
      try {
        const txHash = await wallet.writeContract({
          address: usdc,
          abi: USDC_ABI,
          functionName: "transferWithAuthorization",
          args: [authorization.from, authorization.to, authorization.value, authorization.validAfter, authorization.validBefore, authorization.nonce, vByte, r, s],
          chain: undefined,
          account,
        });
        return { txHash, broadcastedAt: new Date().toISOString(), strategy: "eip3009" };
      } catch (err) {
        if (opts.allowTransferFallback ?? true) {
          // Fallback: plain ERC-20 transfer of the exact amount. Server-side
          // verification is identical (Transfer log to payTo with exact value).
          const txHash = await wallet.writeContract({
            address: usdc,
            abi: USDC_ABI,
            functionName: "transfer",
            args: [authorization.to, authorization.value],
            chain: undefined,
            account,
          });
          return { txHash, broadcastedAt: new Date().toISOString(), strategy: "transfer" };
        }
        throw err;
      }
    },
    async waitForReceipt(txHash) {
      const timeoutMs = opts.receiptTimeoutMs ?? 60_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const receipt: TransactionReceipt | null = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
        if (receipt) {
          return {
            status: receipt.status === "success" ? "success" : "reverted",
            blockNumber: receipt.blockNumber,
          };
        }
        if (Date.now() > deadline) {
          throw new Error(`waitForReceipt: timed out waiting for ${txHash}`);
        }
        await new Promise((r) => setTimeout(r, 600));
      }
    },
  };
}

// --- Simulated (zero-risk demo mode) -------------------------------------------

export interface SimulatedTxRecord {
  txHash: Hex;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  token: `0x${string}`;
  blockNumber: bigint;
  status: "success" | "reverted";
  intentId: Hex;
}

/**
 * Shared in-memory chain used by BOTH the simulated broadcaster and the
 * simulated tx prober, so the full x402 verify/settle pipeline is exercised
 * end-to-end without spending real tokens.
 */
export class SimulatedChain {
  private readonly txs = new Map<Hex, SimulatedTxRecord>();
  private blockCounter = 5_000_000n;
  private seq = 0;

  settle(params: { from: `0x${string}`; to: `0x${string}`; value: bigint; token: `0x${string}`; intentId: Hex; status?: "success" | "reverted" }): Hex {
    this.blockCounter += 1n;
    // Deterministic hash seeded with "simtx:" (hex 73696d7478...) so simulated
    // settlements are visually identifiable and still valid 32-byte hashes.
    // Same (intent, parties, amount) => same tx hash, mirroring chain semantics.
    const txHash = keccak256(
      stringToHex(`simtx:${params.intentId}:${params.from}:${params.to}:${params.value}`),
    );
    this.txs.set(txHash, {
      txHash,
      from: params.from,
      to: params.to,
      value: params.value,
      token: params.token,
      blockNumber: this.blockCounter,
      status: params.status ?? "success",
      intentId: params.intentId,
    });
    return txHash;
  }

  getProof(txHash: Hex): SimulatedTxRecord | null {
    return this.txs.get(txHash) ?? null;
  }

  all(): SimulatedTxRecord[] {
    return [...this.txs.values()];
  }

  get blockNumber(): bigint {
    return this.blockCounter;
  }
}

let simChainSingleton: SimulatedChain | null = null;
export function sharedSimulatedChain(): SimulatedChain {
  if (!simChainSingleton) simChainSingleton = new SimulatedChain();
  return simChainSingleton;
}

export function createSimulatedBroadcastAdapter(params: {
  chain?: SimulatedChain;
  payer: `0x${string}`;
  usdc: `0x${string}`;
}): BroadcastAdapter {
  const sim = params.chain ?? sharedSimulatedChain();
  let count = 0;
  return {
    name: "simulated",
    get broadcastCount() {
      return count;
    },
    async broadcastTransferWithAuthorization({ authorization, intentId }) {
      count += 1;
      const txHash = sim.settle({
        from: authorization.from,
        to: authorization.to,
        value: authorization.value,
        token: params.usdc,
        intentId,
      });
      return { txHash, broadcastedAt: new Date().toISOString(), strategy: "eip3009" };
    },
    async waitForReceipt(txHash) {
      const rec = sim.getProof(txHash);
      if (!rec) throw new Error(`simulated waitForReceipt: unknown tx ${txHash}`);
      return { status: rec.status, blockNumber: rec.blockNumber };
    },
  };
}

// --- Optional external facilitator adapter -------------------------------------

export interface FacilitatorClientOptions {
  baseUrl: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Adapter point for an external x402 facilitator exposing `/verify` and
 * `/settle`. When X402_FACILITATOR_URL is configured, the buyer posts the
 * EIP-3009 authorization there instead of self-broadcasting; the facilitator
 * returns the settlement txHash. Self-settlement remains the default path.
 */
export class FacilitatorClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: FacilitatorClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async post<T>(path: "/verify" | "/settle", body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 90_000);
    try {
      const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`facilitator ${path} failed: HTTP ${res.status}`);
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  verify(payload: { x402Version: number; scheme: string; network: string; authorization: unknown; signature: string }, requirements: unknown) {
    return this.post<{ isValid: boolean; invalidReason?: string; payer?: string }>("/verify", {
      x402PaymentPayload: payload,
      x402PaymentRequirements: requirements,
    });
  }

  settle(payload: { x402Version: number; scheme: string; network: string; authorization: unknown; signature: string }, requirements: unknown) {
    return this.post<{ success: boolean; txHash?: string; error?: string }>("/settle", {
      x402PaymentPayload: payload,
      x402PaymentRequirements: requirements,
    });
  }
}

/** Exported for tests: calldata builder parity with the adapter. */
export function transferWithAuthorizationCalldata(auth: Eip3009Authorization, signature: Hex): Hex {
  const { v, r, s, yParity } = hexToSignature(signature);
  const vByte = Number(v ?? (yParity === 0 ? 27 : 28));
  return encodeFunctionData({
    abi: USDC_ABI,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, vByte, r, s],
  });
}

export const MAX_UINT256 = maxUint256;
export const TRANSFER_EVENT_TOPIC = keccak256(stringToHex("Transfer(address,address,uint256)"));
export const CHAIN_ID_EXPECTED = CHAIN_ID;
export { parseEventLogs };
