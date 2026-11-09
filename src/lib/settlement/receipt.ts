/**
 * On-chain payment proof extraction: a settlement is valid when the tx succeeded
 * and its logs contain a USDC `Transfer(from, to, value)` event matching the
 * challenged recipient and exact amount.
 */
import { createPublicClient, http, type Chain, type TransactionReceipt } from "viem";
import { decodeEventLog, keccak256, stringToHex, type Hex } from "viem";
import { pharosAtlantic, rpcUrlFromEnv, usdcAddressFromEnv } from "../chain";

export const TRANSFER_EVENT_TOPIC: Hex = keccak256(stringToHex("Transfer(address,address,uint256)"));

export interface OnchainPaymentProof {
  status: "success" | "reverted";
  blockNumber: bigint;
  token: Hex | null;
  transfer: { from: Hex; to: Hex; value: bigint } | null;
}

export interface TxProber {
  readonly name: string;
  chainId(): Promise<number>;
  getPaymentProof(txHash: Hex): Promise<OnchainPaymentProof | null>;
}

export function extractTransferProof(receipt: TransactionReceipt, usdcAddress: Hex): OnchainPaymentProof {
  const status = receipt.status === "success" ? "success" : "reverted";
  let transfer: OnchainPaymentProof["transfer"] = null;
  let token: Hex | null = null;
  for (const log of receipt.logs) {
    if (log.topics[0] !== TRANSFER_EVENT_TOPIC || log.topics.length < 3) continue;
    try {
      const ev = decodeEventLog({
        abi: [
          {
            type: "event",
            name: "Transfer",
            inputs: [
              { name: "from", type: "address", indexed: true },
              { name: "to", type: "address", indexed: true },
              { name: "value", type: "uint256", indexed: false },
            ],
          },
        ],
        data: log.data,
        topics: log.topics as [Hex, Hex, Hex],
      });
      if (!ev.args) continue;
      const from = ev.args.from as Hex;
      const to = ev.args.to as Hex;
      const value = ev.args.value as bigint;
      if (log.address.toLowerCase() === usdcAddress.toLowerCase()) {
        token = log.address;
        transfer = { from, to, value };
        break;
      }
    } catch {
      // not a matching event shape; skip
    }
  }
  return { status, blockNumber: receipt.blockNumber, token, transfer };
}

export function createViemTxProber(opts: { rpcUrl?: string; chain?: Chain; usdcAddress?: Hex } = {}): TxProber {
  const rpcUrl = opts.rpcUrl ?? rpcUrlFromEnv();
  const chain = opts.chain ?? pharosAtlantic(rpcUrl);
  const usdc = (opts.usdcAddress ?? usdcAddressFromEnv()) as Hex;
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  return {
    name: "viem-live",
    async chainId() {
      return pub.getChainId();
    },    async getPaymentProof(txHash) {
      const receipt = await pub.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!receipt) return null;
      return extractTransferProof(receipt, usdc);
    },
  };
}
