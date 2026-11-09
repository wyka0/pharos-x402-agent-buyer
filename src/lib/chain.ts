/**
 * Pharos Atlantic Testnet constants and viem chain definition.
 *
 * Verified against:
 * - https://docs.pharos.xyz/getting-started/network/atlantic-testnet
 * - https://docs.pharos.xyz/getting-started/token-registry
 * - Sibling verified stack: "C:\pharos-x402-paywalled-api\src\network.ts"
 */
import { defineChain, type Chain } from "viem";

export const CHAIN_ID = 688_689 as const;
export const NETWORK_ID = "eip155:688689" as const;
export const NETWORK_NAME = "Pharos Atlantic Testnet";
export const DEFAULT_RPC_URL = "https://atlantic.dplabs-internal.com";
export const DEFAULT_EXPLORER_URL = "https://atlantic.pharosscan.xyz";

/** Official Atlantic USDC from the Pharos Token Registry (EIP-3009 capable). */
export const DEFAULT_USDC_ADDRESS = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B" as const;
export const USDC_NAME = "USDC";
export const USDC_VERSION = "2";
export const USDC_SYMBOL = "USDC";
export const USDC_DECIMALS = 6;
export const NATIVE_GAS_DECIMALS = 18;

export const X402_VERSION = 2 as const;
export const X402_SCHEME = "exact" as const;

export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

export const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** viem chain definition for Pharos Atlantic Testnet. */
export function pharosAtlantic(rpcUrl: string = DEFAULT_RPC_URL): Chain {
  return defineChain({
    id: CHAIN_ID,
    name: NETWORK_NAME,
    nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: NATIVE_GAS_DECIMALS },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: "PharosScan Atlantic", url: DEFAULT_EXPLORER_URL } },
    testnet: true,
  });
}

export function explorerTxUrl(txHash: string, base: string = DEFAULT_EXPLORER_URL): string {
  if (!TX_HASH_PATTERN.test(txHash)) {
    throw new Error("Cannot build an explorer link: value is not a 32-byte hex transaction hash.");
  }
  return `${base}/tx/${txHash}`;
}

export function explorerAddressUrl(address: string, base: string = DEFAULT_EXPLORER_URL): string {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new Error("Cannot build an explorer link: value is not a 20-byte hex address.");
  }
  return `${base}/address/${address}`;
}

// --- Environment accessors (server-side only) --------------------------------

export function rpcUrlFromEnv(): string {
  return process.env.PHAROS_RPC_URL?.trim() || DEFAULT_RPC_URL;
}

export function usdcAddressFromEnv(): `0x${string}` {
  const v = process.env.PHAROS_USDC_ADDRESS?.trim() || DEFAULT_USDC_ADDRESS;
  if (!ADDRESS_PATTERN.test(v)) throw new Error("PHAROS_USDC_ADDRESS is not a valid address");
  return v as `0x${string}`;
}

export function explorerUrlFromEnv(): string {
  return process.env.PHAROS_EXPLORER_URL?.trim() || DEFAULT_EXPLORER_URL;
}

export function payToFromEnv(): `0x${string}` {
  const v = process.env.PAY_TO_ADDRESS?.trim() || "";
  if (!ADDRESS_PATTERN.test(v)) {
    throw new Error("PAY_TO_ADDRESS is missing or not a valid address (.env.local)");
  }
  return v as `0x${string}`;
}

/** Returns the payer private key from env, or null when not configured. */
export function payerKeyFromEnv(): `0x${string}` | null {
  const v = process.env.TEST_USER_PRIVATE_KEY?.trim() || "";
  if (!v || v === "0xYOUR_PRIVATE_KEY_HERE") return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error("TEST_USER_PRIVATE_KEY is present but malformed (expected 32-byte hex)");
  }
  return v as `0x${string}`;
}
