/**
 * Server-side x402 payment verification (Requirement 04 server half).
 *
 * Verification pipeline for a presented PAYMENT-SIGNATURE payload:
 *   1. Protocol echo checks (scheme / network / x402Version / pricing fields)
 *   2. Innovation #1: recompute quoteCommitment + settlementCommitment from the
 *      SERVER'S OWN pricing â€” rejects bait-and-switch of resource/price/recipient
 *   3. EIP-3009 authorization window + signature recovery to `from`
 *   4. Idempotency: intentId receipts (same proof -> replay 200; different tx for
 *      the same intent -> conflict) and nonce reuse across intents
 *   5. On-chain proof via TxProber: success status + USDC Transfer log to payTo
 *      with the exact challenged amount
 *
 * A settled intent is recorded once; re-presenting the same paid proof returns
 * the stored receipt with replay=true and never re-charges.
 */
import type { Hex, X402PaymentPayload, X402PaymentRequirements } from "../x402";
import { computeQuoteCommitment, bindSettlement } from "../commitment";
import { verifyAuthorizationSignature, isAuthorizationWindowValid, type Eip3009Authorization } from "../settlement/signer";
import type { TxProber, OnchainPaymentProof } from "../settlement/receipt";

export type VerificationErrorCode =
  | "SCHEME_MISMATCH"
  | "NETWORK_MISMATCH"
  | "PRICE_MISMATCH"
  | "RECIPIENT_MISMATCH"
  | "ASSET_MISMATCH"
  | "COMMITMENT_MISMATCH"
  | "SETTLEMENT_COMMITMENT_MISMATCH"
  | "AUTH_WINDOW_INVALID"
  | "AUTH_SIGNATURE_INVALID"
  | "RECEIPT_CONFLICT"
  | "NONCE_REUSED"
  | "TX_NOT_FOUND"
  | "TX_REVERTED"
  | "NO_USDC_TRANSFER"
  | "WRONG_RECIPIENT_ONCHAIN"
  | "AMOUNT_MISMATCH"
  | "WRONG_ASSET_ONCHAIN";

export interface SettlementRecord {
  intentId: Hex;
  txHash: Hex;
  blockNumber: string;
  amountRaw: string;
  payer: string;
  payTo: string;
  asset: string;
  settledAt: string;
  replayCount: number;
  nonce: Hex;
}

export interface ReceiptStore {
  get(intentId: Hex): SettlementRecord | undefined;
  getByNonce(nonce: Hex): SettlementRecord | undefined;
  put(record: SettlementRecord): void;
  all(): SettlementRecord[];
}

export class InMemoryReceiptStore implements ReceiptStore {
  private byIntent = new Map<string, SettlementRecord>();
  private byNonce = new Map<string, SettlementRecord>();

  get(intentId: Hex): SettlementRecord | undefined {
    return this.byIntent.get(intentId);
  }
  getByNonce(nonce: Hex): SettlementRecord | undefined {
    return this.byNonce.get(nonce);
  }
  put(record: SettlementRecord): void {
    this.byIntent.set(record.intentId, record);
    this.byNonce.set(record.nonce, record);
  }
  all(): SettlementRecord[] {
    return [...this.byIntent.values()];
  }
}

export type VerifyResult =
  | { ok: true; settlement: SettlementRecord; replay: boolean; proof: OnchainPaymentProof }
  | { ok: false; code: VerificationErrorCode; detail: string };

export interface PaymentVerifierOptions {
  prober: TxProber;
  receipts: ReceiptStore;
  payTo: string;
  asset: string; // USDC address
  network: string; // eip155:688689
  chainId: number; // 688689
  verifierName?: string;
  now?: () => Date;
}

export class PaymentVerifier {
  readonly name: string;
  private readonly nowFn: () => Date;

  constructor(private readonly opts: PaymentVerifierOptions) {
    this.name = opts.verifierName ?? "pharos-x402-verifier";
    this.nowFn = opts.now ?? (() => new Date());
  }

  receipts(): ReceiptStore {
    return this.opts.receipts;
  }

  async verifyPayment(echo: X402PaymentRequirements, payload: X402PaymentPayload): Promise<VerifyResult> {
    const fail = (code: VerificationErrorCode, detail: string): VerifyResult => ({ ok: false, code, detail });

    // 1) Protocol echo checks
    if (payload.scheme !== echo.scheme || payload.scheme !== "exact") return fail("SCHEME_MISMATCH", "payload/echo scheme mismatch");
    if (payload.network !== echo.network || payload.network !== this.opts.network) {
      return fail("NETWORK_MISMATCH", `expected ${this.opts.network}`);
    }
    if (echo.x402Version !== 2 || payload.x402Version !== 2) return fail("SCHEME_MISMATCH", "x402Version must be 2");
    if (echo.asset.toLowerCase() !== this.opts.asset.toLowerCase()) return fail("ASSET_MISMATCH", `expected asset ${this.opts.asset}`);
    if (echo.payTo.toLowerCase() !== this.opts.payTo.toLowerCase()) {
      return fail("RECIPIENT_MISMATCH", `expected payTo ${this.opts.payTo}`);
    }
    if (echo.maxAmountRequired !== payload.authorization.value) {
      return fail("PRICE_MISMATCH", `authorization value ${payload.authorization.value} != challenged ${echo.maxAmountRequired}`);
    }

    // 2) Commitment recomputation from the SERVER'S OWN challenge parameters
    const recomputedQuote = computeQuoteCommitment({
      scheme: echo.scheme,
      network: echo.network,
      resource: echo.resource,
      asset: echo.asset,
      payTo: echo.payTo,
      maxAmountRequired: echo.maxAmountRequired,
      chainId: this.opts.chainId,
      nonce: echo.extra.nonce as Hex,
    });
    if (recomputedQuote !== echo.extra.quoteCommitment || recomputedQuote !== payload.quoteCommitment) {
      return fail("COMMITMENT_MISMATCH", "quoteCommitment does not bind the challenged parameters");
    }
    const recomputedSettlement = bindSettlement(recomputedQuote, payload.txHash);
    if (recomputedSettlement !== payload.settlementCommitment) {
      return fail("SETTLEMENT_COMMITMENT_MISMATCH", "settlementCommitment does not bind (quote, txHash)");
    }

    // 3) EIP-3009 authorization window + signature
    const auth: Eip3009Authorization = {
      from: payload.authorization.from as `0x${string}`,
      to: payload.authorization.to as `0x${string}`,
      value: BigInt(payload.authorization.value),
      validAfter: BigInt(payload.authorization.validAfter),
      validBefore: BigInt(payload.authorization.validBefore),
      nonce: payload.authorization.nonce as Hex,
    };
    if (auth.to.toLowerCase() !== this.opts.payTo.toLowerCase()) {
      return fail("RECIPIENT_MISMATCH", "authorization.to != payTo");
    }
    const nowSec = Math.floor(this.nowFn().getTime() / 1000);
    if (!isAuthorizationWindowValid(auth, nowSec)) {
      return fail("AUTH_WINDOW_INVALID", `authorization window invalid at ${nowSec} (validAfter ${auth.validAfter}, validBefore ${auth.validBefore})`);
    }
    if (payload.signature.length > 0) {
      const sigOk = await verifyAuthorizationSignature({
        auth,
        signature: payload.signature as Hex,
        verifyingContract: this.opts.asset as `0x${string}`,
        chainId: this.opts.chainId,
      });
      if (!sigOk) return fail("AUTH_SIGNATURE_INVALID", "EIP-3009 signature does not recover to authorization.from");
    }

    // 4) Idempotency â€” receipts by intentId and nonce
    const existing = this.opts.receipts.get(payload.intentId);
    if (existing) {
      if (existing.txHash.toLowerCase() === payload.txHash.toLowerCase()) {
        const replay: SettlementRecord = { ...existing, replayCount: existing.replayCount + 1 };
        this.opts.receipts.put(replay);
        return { ok: true, settlement: replay, replay: true, proof: { status: "success", blockNumber: BigInt(existing.blockNumber), token: this.opts.asset as Hex, transfer: { from: existing.payer as Hex, to: existing.payTo as Hex, value: BigInt(existing.amountRaw) } } };
      }
      return fail("RECEIPT_CONFLICT", `intent ${payload.intentId} already settled with a different tx ${existing.txHash}`);
    }
    const nonceOwner = this.opts.receipts.getByNonce(auth.nonce);
    if (nonceOwner && nonceOwner.intentId !== payload.intentId) {
      return fail("NONCE_REUSED", "authorization nonce already used by a different intent");
    }

    // 5) On-chain proof
    const proof = await this.opts.prober.getPaymentProof(payload.txHash);
    if (!proof) return fail("TX_NOT_FOUND", `settlement tx ${payload.txHash} not found on ${this.opts.network}`);
    if (proof.status !== "success") return fail("TX_REVERTED", `settlement tx ${payload.txHash} reverted`);
    if (!proof.transfer) return fail("NO_USDC_TRANSFER", "no USDC Transfer event found in the settlement tx");
    if (proof.token && proof.token.toLowerCase() !== this.opts.asset.toLowerCase()) {
      return fail("WRONG_ASSET_ONCHAIN", "transfer token is not the challenged asset");
    }
    if (proof.transfer.to.toLowerCase() !== this.opts.payTo.toLowerCase()) {
      return fail("WRONG_RECIPIENT_ONCHAIN", `on-chain recipient ${proof.transfer.to} != payTo ${this.opts.payTo}`);
    }
    const expectedAmount = BigInt(echo.maxAmountRequired);
    if (proof.transfer.value !== expectedAmount) {
      return fail("AMOUNT_MISMATCH", `on-chain amount ${proof.transfer.value} != challenged ${expectedAmount}`);
    }

    const record: SettlementRecord = {
      intentId: payload.intentId,
      txHash: payload.txHash,
      blockNumber: proof.blockNumber.toString(),
      amountRaw: proof.transfer.value.toString(),
      payer: proof.transfer.from,
      payTo: this.opts.payTo,
      asset: this.opts.asset,
      settledAt: this.nowFn().toISOString(),
      replayCount: 0,
      nonce: auth.nonce,
    };
    this.opts.receipts.put(record);
    return { ok: true, settlement: record, replay: false, proof };
  }
}
