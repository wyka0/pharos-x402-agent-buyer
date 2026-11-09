/**
 * Client-side verification of the server's PAYMENT-RESPONSE header (Step 4):
 * the settlement must bind to the exact quote commitment and tx the agent paid,
 * with the exact challenged amount — closing the loop on Innovation #1.
 */
import { PAYMENT_RESPONSE_HEADER, decodePaymentResponse } from "../x402";
import { bindSettlement } from "../commitment";
import type { X402PaymentPayload } from "../x402";

export function verifyDeliveryResponse(response: Response, sent: X402PaymentPayload, expectedNetwork: string): string {
  const raw = response.headers.get(PAYMENT_RESPONSE_HEADER);
  if (!raw) throw new Error("missing PAYMENT-RESPONSE header on 200 response");
  const decoded = decodePaymentResponse(raw);
  if (decoded.scheme !== sent.scheme) throw new Error("scheme mismatch in PAYMENT-RESPONSE");
  if (decoded.network !== expectedNetwork) throw new Error("network mismatch in PAYMENT-RESPONSE");
  if (!decoded.settlement.success) throw new Error("settlement reported unsuccessful");
  if (decoded.settlement.txHash.toLowerCase() !== sent.txHash.toLowerCase()) {
    throw new Error(`settlement txHash mismatch: server says ${decoded.settlement.txHash}, agent paid ${sent.txHash}`);
  }
  if (decoded.settlement.amount !== sent.requirementsEcho.maxAmountRequired) {
    throw new Error(`settled amount ${decoded.settlement.amount} != challenged ${sent.requirementsEcho.maxAmountRequired}`);
  }
  const recomputed = bindSettlement(sent.quoteCommitment, sent.txHash);
  if (recomputed !== sent.settlementCommitment) {
    throw new Error("settlement commitment mismatch in PAYMENT-RESPONSE");
  }
  if (decoded.receipt.intentId.toLowerCase() !== sent.intentId.toLowerCase()) {
    throw new Error("receipt intentId mismatch");
  }
  return `tx ${decoded.settlement.txHash.slice(0, 10)}... block ${decoded.settlement.blockNumber}${decoded.receipt.replay ? ", idempotent replay" : ""}`;
}
