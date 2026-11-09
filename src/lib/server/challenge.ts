/**
 * Server-side challenge builder: constructs the PaymentRequired object (with a
 * fresh nonce and the Innovation #1 quoteCommitment) and Base64-encodes it for
 * the `PAYMENT-REQUIRED` response header.
 */
import { toHex, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import { X402_VERSION } from "../chain";
import type { X402PaymentRequired, X402PaymentRequirements } from "../x402";
import { encodePaymentRequired } from "../x402";
import { computeQuoteCommitment, challengeIdempotencyKey } from "../commitment";
import type { EndpointSpec } from "./catalog";

export interface BuildChallengeParams {
  resource: string; // absolute URL
  spec: EndpointSpec;
  network: string; // eip155:688689
  chainId: number; // 688689
  asset: string; // USDC
  payTo: string;
  /** Injectable for deterministic tests. */
  nonceGen?: () => Hex;
}

export function buildChallenge(p: BuildChallengeParams): { required: X402PaymentRequired; header: string; requirements: X402PaymentRequirements } {
  const nonce = p.nonceGen ? p.nonceGen() : (toHex(randomBytes(32)) as Hex);
  const idempotencyKey = challengeIdempotencyKey(p.resource, nonce);
  const base: Omit<X402PaymentRequirements, "extra"> & { extra: unknown } = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: p.network,
    asset: p.asset,
    payTo: p.payTo,
    maxAmountRequired: p.spec.priceRaw.toString(),
    resource: p.resource,
    description: p.spec.description,
    mimeType: p.spec.mimeType,
    maxTimeoutSeconds: p.spec.maxTimeoutSeconds,
    extra: null as unknown as X402PaymentRequirements["extra"],
  };
  const quoteCommitment = computeQuoteCommitment({
    scheme: base.scheme,
    network: base.network,
    resource: base.resource,
    asset: base.asset,
    payTo: base.payTo,
    maxAmountRequired: base.maxAmountRequired,
    chainId: p.chainId,
    nonce,
  });
  const requirements: X402PaymentRequirements = {
    ...base,
    extra: {
      name: "USDC",
      version: "2",
      chainId: p.chainId,
      nonce,
      idempotencyKey,
      quoteCommitment,
      advertisedUtility: p.spec.advertisedUtility,
    },
  };
  const required: X402PaymentRequired = { x402Version: X402_VERSION, accepts: [requirements] };
  return { required, header: encodePaymentRequired(required), requirements };
}
