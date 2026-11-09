/**
 * x402 protocol types + HTTP header codec (Pharos spec, x402 v2, scheme "exact").
 *
 * Protocol flow (https://docs.pharos.xyz/developer-guide/x402):
 *   1. Agent requests resource            -> HTTP 402 + Base64 `PAYMENT-REQUIRED` header
 *   2. Agent decodes, evaluates ROI/budget -> deterministic gate BEFORE signing
 *   3. Agent settles on-chain (USDC EIP-3009) and re-requests with a Base64
 *      `PAYMENT-SIGNATURE` header (+ `Idempotency-Key`)
 *   4. Server verifies (idempotently)      -> HTTP 200 + Base64 `PAYMENT-RESPONSE` header
 */
import {
  X402_SCHEME,
  X402_VERSION,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  PAYMENT_RESPONSE_HEADER,
  IDEMPOTENCY_KEY_HEADER,
} from "./chain";

export { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER, PAYMENT_RESPONSE_HEADER, IDEMPOTENCY_KEY_HEADER };

export type Hex = `0x${string}`;

export interface AdvertisedUtility {
  /** Server-claimed informational value of the payload, denominated in USDC. */
  valueUSDC: string;
  /** Server-claimed count of discrete data signals in the payload. */
  expectedSignals: number;
}

/** The `accepts[]` entry of a PaymentRequired object (x402 v2, exact scheme). */
export interface X402PaymentRequirements {
  x402Version: number;
  scheme: typeof X402_SCHEME;
  network: string; // "eip155:688689"
  asset: string; // USDC contract (checksummed)
  payTo: string;
  maxAmountRequired: string; // raw units as decimal string (6 decimals)
  resource: string; // absolute URL of the paywalled resource
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string; // "USDC"
    version: string; // "2"
    chainId: number; // 688689 (explicit for commitment binding)
    nonce: Hex; // fresh per challenge; deterministically derived under test
    idempotencyKey: string; // per-challenge id
    quoteCommitment: Hex; // keccak binding of every field above (Innovation #1)
    advertisedUtility: AdvertisedUtility;
  };
}

/** Object encoded into the `PAYMENT-REQUIRED` response header. */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  accepts: X402PaymentRequirements[];
}

/** Object encoded into the `PAYMENT-SIGNATURE` request header. */
export interface X402PaymentPayload {
  x402Version: number;
  scheme: typeof X402_SCHEME;
  network: string;
  resource: string;
  /** Exact requirements object the client accepted from the 402 challenge. */
  requirementsEcho: X402PaymentRequirements;
  /** Deterministic keccak(taskRunId, endpointUrl, stepIndex, resourceHash). */
  intentId: Hex;
  authorization: {
    from: string;
    to: string;
    value: string; // raw units decimal string
    validAfter: string; // unix seconds decimal string
    validBefore: string; // unix seconds decimal string
    nonce: Hex; // deterministic from intentId -> chain-level replay protection
  };
  /** EIP-3009 TransferWithAuthorization signature (65-byte hex). Empty for plain-transfer fallback. */
  signature: string;
  /** On-chain settlement tx (broadcast by the buyer or a facilitator). */
  txHash: Hex;
  quoteCommitment: Hex;
  /** keccak(quoteCommitment, txHash) — binds challenge params to settlement tx. */
  settlementCommitment: Hex;
}

/** Object encoded into the `PAYMENT-RESPONSE` response header. */
export interface X402PaymentResponse {
  scheme: string;
  network: string;
  settlement: {
    success: boolean;
    txHash: Hex;
    blockNumber: string;
    amount: string; // raw units decimal string
    payer: string;
    payTo: string;
    asset: string;
    settledAt: string; // ISO
  };
  receipt: {
    intentId: Hex;
    idempotencyKey: string;
    /** True when a previously settled proof was re-presented (no double charge). */
    replay: boolean;
    deliveredAt: string;
    verifier: string;
  };
}

// --- Base64 codec (universal: Node Buffer or DOM atob/btoa) ------------------

export function toBase64(text: string): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function fromBase64(value: string): string {
  const clean = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new X402HeaderError("MALFORMED_BASE64", "header value is not valid base64");
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(clean, "base64").toString("utf8");
  }
  const bin = atob(clean);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class X402HeaderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.name = "X402HeaderError";
  }
}

// --- Encode / decode ---------------------------------------------------------

export function encodePaymentRequired(required: X402PaymentRequired): string {
  return toBase64(JSON.stringify(required));
}

export function encodePaymentPayload(payload: X402PaymentPayload): string {
  return toBase64(JSON.stringify(payload));
}

export function encodePaymentResponse(response: X402PaymentResponse): string {
  return toBase64(JSON.stringify(response));
}

export function decodePaymentRequired(header: string): X402PaymentRequired {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new X402HeaderError("UNDECODABLE_PAYMENT_REQUIRED", `PAYMENT-REQUIRED could not be decoded: ${String(e)}`);
  }
  return assertPaymentRequired(parsed);
}

export function decodePaymentPayload(header: string): X402PaymentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new X402HeaderError("UNDECODABLE_PAYMENT_PAYLOAD", `PAYMENT-SIGNATURE could not be decoded: ${String(e)}`);
  }
  return assertPaymentPayload(parsed);
}

export function decodePaymentResponse(header: string): X402PaymentResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64(header));
  } catch (e) {
    throw new X402HeaderError("UNDECODABLE_PAYMENT_RESPONSE", `PAYMENT-RESPONSE could not be decoded: ${String(e)}`);
  }
  return assertPaymentResponse(parsed);
}

// --- Structural validation ----------------------------------------------------

function isHex32(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);
}
function isAddressLike(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}
function isDecimalString(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v) && v.length < 79;
}

export function assertPaymentRequirements(v: unknown): X402PaymentRequirements {
  if (typeof v !== "object" || v === null) {
    throw new X402HeaderError("SCHEMA_PAYMENT_REQUIREMENTS", "expected an object");
  }
  const r = v as Record<string, unknown>;
  if (r.x402Version !== X402_VERSION) {
    throw new X402HeaderError("UNSUPPORTED_X402_VERSION", `expected x402Version ${X402_VERSION}`);
  }
  if (r.scheme !== X402_SCHEME) {
    throw new X402HeaderError("UNSUPPORTED_SCHEME", `expected scheme "${X402_SCHEME}"`);
  }
  if (typeof r.network !== "string" || !/^eip155:\d+$/.test(r.network)) {
    throw new X402HeaderError("SCHEMA_NETWORK", "network must be a CAIP-2 eip155 id");
  }
  if (!isAddressLike(r.asset)) throw new X402HeaderError("SCHEMA_ASSET", "asset must be an address");
  if (!isAddressLike(r.payTo)) throw new X402HeaderError("SCHEMA_PAY_TO", "payTo must be an address");
  if (!isDecimalString(r.maxAmountRequired)) {
    throw new X402HeaderError("SCHEMA_MAX_AMOUNT", "maxAmountRequired must be a decimal string of raw units");
  }
  if (typeof r.resource !== "string" || !r.resource.startsWith("http")) {
    throw new X402HeaderError("SCHEMA_RESOURCE", "resource must be an absolute URL");
  }
  if (typeof r.description !== "string" || typeof r.mimeType !== "string") {
    throw new X402HeaderError("SCHEMA_DESCRIPTION", "description and mimeType are required strings");
  }
  if (typeof r.maxTimeoutSeconds !== "number" || r.maxTimeoutSeconds <= 0) {
    throw new X402HeaderError("SCHEMA_TIMEOUT", "maxTimeoutSeconds must be a positive number");
  }
  const extra = r.extra as Record<string, unknown> | undefined;
  if (typeof extra !== "object" || extra === null) {
    throw new X402HeaderError("SCHEMA_EXTRA", "extra is required");
  }
  if (typeof extra.name !== "string" || typeof extra.version !== "string") {
    throw new X402HeaderError("SCHEMA_EXTRA_TOKEN", "extra.name / extra.version are required");
  }
  if (typeof extra.chainId !== "number" || extra.chainId <= 0) {
    throw new X402HeaderError("SCHEMA_EXTRA_CHAIN", "extra.chainId must be a positive number");
  }
  if (!isHex32(extra.nonce)) throw new X402HeaderError("SCHEMA_EXTRA_NONCE", "extra.nonce must be a 32-byte hex");
  if (typeof extra.idempotencyKey !== "string" || extra.idempotencyKey.length < 8) {
    throw new X402HeaderError("SCHEMA_EXTRA_IDEMPOTENCY", "extra.idempotencyKey is required");
  }
  if (!isHex32(extra.quoteCommitment)) {
    throw new X402HeaderError("SCHEMA_EXTRA_COMMITMENT", "extra.quoteCommitment must be a 32-byte hex");
  }
  const adv = extra.advertisedUtility as Record<string, unknown> | undefined;
  if (
    typeof adv !== "object" ||
    adv === null ||
    typeof adv.valueUSDC !== "string" ||
    !/^\d+(\.\d{1,6})?$/.test(adv.valueUSDC) ||
    typeof adv.expectedSignals !== "number"
  ) {
    throw new X402HeaderError("SCHEMA_EXTRA_UTILITY", "extra.advertisedUtility is malformed");
  }
  return r as unknown as X402PaymentRequirements;
}

export function assertPaymentRequired(v: unknown): X402PaymentRequired {
  if (typeof v !== "object" || v === null) {
    throw new X402HeaderError("SCHEMA_PAYMENT_REQUIRED", "expected an object");
  }
  const p = v as Record<string, unknown>;
  if (p.x402Version !== X402_VERSION) {
    throw new X402HeaderError("UNSUPPORTED_X402_VERSION", `expected x402Version ${X402_VERSION}`);
  }
  if (!Array.isArray(p.accepts) || p.accepts.length === 0) {
    throw new X402HeaderError("SCHEMA_ACCEPTS", "accepts must be a non-empty array");
  }
  return { x402Version: p.x402Version as number, accepts: p.accepts.map((a) => assertPaymentRequirements(a)) };
}

export function assertPaymentPayload(v: unknown): X402PaymentPayload {
  if (typeof v !== "object" || v === null) {
    throw new X402HeaderError("SCHEMA_PAYMENT_PAYLOAD", "expected an object");
  }
  const p = v as Record<string, unknown>;
  if (p.x402Version !== X402_VERSION) {
    throw new X402HeaderError("UNSUPPORTED_X402_VERSION", `expected x402Version ${X402_VERSION}`);
  }
  if (p.scheme !== X402_SCHEME) throw new X402HeaderError("UNSUPPORTED_SCHEME", `expected scheme "${X402_SCHEME}"`);
  if (typeof p.network !== "string") throw new X402HeaderError("SCHEMA_NETWORK", "network is required");
  if (typeof p.resource !== "string") throw new X402HeaderError("SCHEMA_RESOURCE", "resource is required");
  if (!isHex32(p.intentId)) throw new X402HeaderError("SCHEMA_INTENT_ID", "intentId must be a 32-byte hex");
  if (typeof p.requirementsEcho !== "object" || p.requirementsEcho === null) {
    throw new X402HeaderError("SCHEMA_REQUIREMENTS_ECHO", "requirementsEcho is required");
  }
  const auth = p.authorization as Record<string, unknown> | undefined;
  if (typeof auth !== "object" || auth === null) {
    throw new X402HeaderError("SCHEMA_AUTHORIZATION", "authorization is required");
  }
  if (!isAddressLike(auth.from) || !isAddressLike(auth.to)) {
    throw new X402HeaderError("SCHEMA_AUTH_PARTIES", "authorization.from / .to must be addresses");
  }
  if (!isDecimalString(auth.value) || !isDecimalString(auth.validAfter) || !isDecimalString(auth.validBefore)) {
    throw new X402HeaderError("SCHEMA_AUTH_FIELDS", "authorization value/validAfter/validBefore must be decimal strings");
  }
  if (!isHex32(auth.nonce)) throw new X402HeaderError("SCHEMA_AUTH_NONCE", "authorization.nonce must be 32-byte hex");
  if (typeof p.signature !== "string") throw new X402HeaderError("SCHEMA_SIGNATURE", "signature is required");
  if (!isHex32(p.txHash)) throw new X402HeaderError("SCHEMA_TX_HASH", "txHash must be a 32-byte hex");
  if (!isHex32(p.quoteCommitment) || !isHex32(p.settlementCommitment)) {
    throw new X402HeaderError("SCHEMA_COMMITMENTS", "quoteCommitment/settlementCommitment must be 32-byte hex");
  }
  return p as unknown as X402PaymentPayload;
}

export function assertPaymentResponse(v: unknown): X402PaymentResponse {
  if (typeof v !== "object" || v === null) {
    throw new X402HeaderError("SCHEMA_PAYMENT_RESPONSE", "expected an object");
  }
  const p = v as Record<string, unknown>;
  if (typeof p.scheme !== "string" || typeof p.network !== "string") {
    throw new X402HeaderError("SCHEMA_PAYMENT_RESPONSE", "scheme/network are required");
  }
  const s = p.settlement as Record<string, unknown> | undefined;
  if (typeof s !== "object" || s === null || typeof s.success !== "boolean" || !isHex32(s.txHash)) {
    throw new X402HeaderError("SCHEMA_SETTLEMENT", "settlement.success/.txHash are required");
  }
  const rec = p.receipt as Record<string, unknown> | undefined;
  if (typeof rec !== "object" || rec === null || !isHex32(rec.intentId) || typeof rec.replay !== "boolean") {
    throw new X402HeaderError("SCHEMA_RECEIPT", "receipt.intentId / receipt.replay are required");
  }
  return p as unknown as X402PaymentResponse;
}

// --- Raw header helpers -------------------------------------------------------

export function headerValues(res: Response): { paymentRequired?: string; paymentResponse?: string } {
  return {
    paymentRequired: res.headers.get(PAYMENT_REQUIRED_HEADER) ?? undefined,
    paymentResponse: res.headers.get(PAYMENT_RESPONSE_HEADER) ?? undefined,
  };
}
