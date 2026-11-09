/**
 * EIP-3009 (TransferWithAuthorization) signing for the x402 `exact` scheme on
 * Atlantic USDC (name "USDC", version "2", chainId 688689).
 */
import { verifyTypedData, type TypedDataDomain, type TypedDataDefinition } from "viem";
import { CHAIN_ID, USDC_NAME, USDC_VERSION } from "../chain";
import { nonceFromIntentId } from "../commitment";
import type { Hex } from "../x402";

export interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface SignerLike {
  readonly address: `0x${string}`;
  signTypedData(typedData: TypedDataDefinition): Promise<Hex>;
}

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function usdcDomain(verifyingContract: `0x${string}`, chainId: number = CHAIN_ID): TypedDataDomain {
  return { name: USDC_NAME, version: USDC_VERSION, chainId, verifyingContract };
}

export interface BuildAuthorizationParams {
  payer: `0x${string}`;
  payTo: `0x${string}`;
  amountRaw: bigint;
  intentId: Hex;
  /** Current unix seconds. */
  nowSec: number;
  /** Authorization validity window in seconds (default 900). */
  ttlSec?: number;
}

/**
 * Deterministic authorization for an intent: the nonce is derived from the
 * intentId, so re-deriving it after a crash yields the exact same signature and
 * the chain itself refuses a second settlement of the same authorization.
 */
export function buildAuthorization(p: BuildAuthorizationParams): Eip3009Authorization {
  const ttl = p.ttlSec ?? 900;
  return {
    from: p.payer,
    to: p.payTo,
    value: p.amountRaw,
    validAfter: BigInt(Math.max(0, Math.floor(p.nowSec) - 300)),
    validBefore: BigInt(Math.floor(p.nowSec) + ttl),
    nonce: nonceFromIntentId(p.intentId),
  };
}

export function authorizationTypedData(
  auth: Eip3009Authorization,
  verifyingContract: `0x${string}`,
  chainId: number = CHAIN_ID,
): TypedDataDefinition {
  return {
    domain: usdcDomain(verifyingContract, chainId),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  };
}

export async function signAuthorization(signer: SignerLike, auth: Eip3009Authorization, verifyingContract: `0x${string}`): Promise<Hex> {
  return signer.signTypedData(authorizationTypedData(auth, verifyingContract));
}

/** Server-side check: the presented signature must recover to authorization.from. */
export async function verifyAuthorizationSignature(params: {
  auth: Eip3009Authorization;
  signature: Hex;
  verifyingContract: `0x${string}`;
  chainId?: number;
}): Promise<boolean> {
  return verifyTypedData({
    address: params.auth.from,
    domain: usdcDomain(params.verifyingContract, params.chainId),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: params.auth.from,
      to: params.auth.to,
      value: params.auth.value,
      validAfter: params.auth.validAfter,
      validBefore: params.auth.validBefore,
      nonce: params.auth.nonce,
    },
    signature: params.signature,
  });
}

export function isAuthorizationWindowValid(auth: Eip3009Authorization, nowSec: number): boolean {
  return BigInt(Math.floor(nowSec)) >= auth.validAfter && BigInt(Math.floor(nowSec)) < auth.validBefore;
}
