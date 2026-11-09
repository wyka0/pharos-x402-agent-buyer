/**
 * Innovation #1 — Cryptographic x402 Quote-to-Settlement Commitment.
 *
 * quoteCommitment      = keccak256(scheme, network, resource, asset, payTo,
 *                                   maxAmountRequired, chainId, nonce)
 * settlementCommitment = keccak256(quoteCommitment, txHash)
 *
 * The server computes quoteCommitment when issuing the HTTP 402 challenge; the
 * client recomputes it from the decoded header (proving the header is internally
 * consistent), then binds the on-chain txHash before re-submitting. The server
 * recomputes BOTH from its own pricing at verification time, so a malicious
 * server cannot bait-and-switch price/recipient/resource mid-flight, and a
 * client cannot pay a different recipient/amount than challenged.
 */
import { encodeAbiParameters, keccak256, toHex } from "viem";
import type { Hex } from "./x402";

export interface QuoteChallengeFields {
  scheme: string;
  network: string;
  resource: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string; // decimal string, raw units
  chainId: number;
  nonce: Hex;
}

export function computeQuoteCommitment(f: QuoteChallengeFields): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "string" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        f.scheme,
        f.network,
        f.resource,
        f.asset as `0x${string}`,
        f.payTo as `0x${string}`,
        BigInt(f.maxAmountRequired),
        BigInt(f.chainId),
        f.nonce,
      ],
    ),
  );
}

export function bindSettlement(quoteCommitment: Hex, txHash: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [quoteCommitment, txHash]));
}

/**
 * Stable identity of a paywalled resource: (url, price, recipient).
 * A price change intentionally changes the resourceHash -> a new intentId.
 */
export function computeResourceHash(resource: string, maxAmountRequired: string, payTo: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "uint256" },
        { type: "address" },
      ],
      [resource, BigInt(maxAmountRequired), payTo as `0x${string}`],
    ),
  );
}

/**
 * Innovation #4 backbone — deterministic intent id:
 * intentId = keccak256(taskRunId, endpointUrl, stepIndex, resourceHash)
 */
export function computeIntentId(
  taskRunId: string,
  endpointUrl: string,
  stepIndex: number,
  resourceHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "string" },
        { type: "string" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [taskRunId, endpointUrl, BigInt(stepIndex), resourceHash],
    ),
  );
}

/** Deterministic EIP-3009 nonce from the intentId: chain-level replay protection. */
export function nonceFromIntentId(intentId: Hex): Hex {
  return keccak256(toHex(`${intentId}:eip3009-nonce`));
}

/** Per-challenge idempotency key issued by the server with each 402. */
export function challengeIdempotencyKey(resource: string, nonce: Hex): Hex {
  return keccak256(toHex(`challenge:${resource}:${nonce}`));
}
