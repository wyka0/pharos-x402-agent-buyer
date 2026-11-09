/**
 * Shared x402 endpoint service: one function powers all four paywalled routes.
 *
 * GET without PAYMENT-SIGNATURE  -> 402 + Base64 `PAYMENT-REQUIRED` header
 * GET with valid payment proof   -> 200 + data + Base64 `PAYMENT-RESPONSE` header
 *                                    (idempotent: replayed proofs return the
 *                                     stored settlement, never a double charge)
 * GET with invalid proof         -> 402 + fresh challenge + X-X402-Error code
 */
import type { Hex, X402PaymentPayload, X402PaymentRequirements } from "../x402";
import { decodePaymentPayload, encodePaymentResponse, IDEMPOTENCY_KEY_HEADER, PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "../x402";
import type { PaymentVerifier } from "./verifier";
import { buildChallenge } from "./challenge";
import type { EndpointSpec } from "./catalog";

export interface ServeX402Deps {
  spec: EndpointSpec;
  /** Verifier dispatcher: chooses the right verifier for the presented proof. */
  verifierFor: (payload: X402PaymentPayload) => PaymentVerifier;
  network: string;
  chainId: number;
  asset: string;
  payTo: string;
  /** Data producer override hook (tests). */
  produceOverride?: (input: { resource: string; nonce: Hex; query: URLSearchParams; spec: EndpointSpec }) => unknown;
  now?: () => Date;
}

function resolveOrigin(req: Request): string {
  const forwardedHost = req.headers.get("x-forwarded-host");
  const forwardedProto = req.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    const proto = forwardedProto ?? new URL(req.url).protocol.replace(":", "");
    return `${proto}://${forwardedHost.split(",")[0].trim()}`;
  }
  return new URL(req.url).origin;
}

function noStore(): Record<string, string> {
  return { "cache-control": "no-store" };
}

export async function serveX402(req: Request, deps: ServeX402Deps): Promise<Response> {
  const origin = resolveOrigin(req);
  const url = new URL(req.url);
  const resource = `${origin}${url.pathname}`;

  const signatureHeader = req.headers.get(PAYMENT_SIGNATURE_HEADER);

  // --- Step 1: initial request -> 402 challenge ------------------------------
  if (!signatureHeader) {
    const { header, required } = buildChallenge({
      resource,
      spec: deps.spec,
      network: deps.network,
      chainId: deps.chainId,
      asset: deps.asset,
      payTo: deps.payTo,
    });
    return new Response(
      JSON.stringify(
        {
          error: "payment_required",
          message: `This resource costs ${Number(deps.spec.priceRaw) / 1e6} USDC on Pharos Atlantic. Decode the PAYMENT-REQUIRED header, settle, and retry with a PAYMENT-SIGNATURE header.`,
          x402Version: required.x402Version,
          accepts: required.accepts,
        },
        null,
        2,
      ),
      {
        status: 402,
        headers: {
          ...noStore(),
          [PAYMENT_REQUIRED_HEADER]: header,
          "x-payment-network": deps.network,
        },
      },
    );
  }

  // --- Step 3: paid retry -> verify idempotently ------------------------------
  const idempotencyKey = req.headers.get(IDEMPOTENCY_KEY_HEADER)?.trim() ?? "";
  let payload: X402PaymentPayload;
  try {
    payload = decodePaymentPayload(signatureHeader);
  } catch (e) {
    return challenge402(req, deps, resource, `undecodable PAYMENT-SIGNATURE: ${String(e)}`, "UNDECODABLE_PAYMENT_PAYLOAD");
  }

  if (idempotencyKey && idempotencyKey !== payload.intentId) {
    return challenge402(req, deps, resource, "Idempotency-Key header does not match payload.intentId", "IDEMPOTENCY_KEY_MISMATCH");
  }

  // The requirements the CLIENT claims to have accepted — verified against the
  // server's own pricing below via the commitment recomputation.
  const echo = payload.requirementsEcho as X402PaymentRequirements;

  const verifier = deps.verifierFor(payload);
  const result = await verifier.verifyPayment(echo, payload);
  if (!result.ok) {
    return challenge402(req, deps, resource, `payment verification failed: ${result.code} — ${result.detail}`, result.code);
  }

  const now = deps.now?.() ?? new Date();
  const nonce = echo.extra.nonce;
  const data = deps.produceOverride
    ? deps.produceOverride({ resource, nonce, query: url.searchParams, spec: deps.spec })
    : deps.spec.produce({ resource, nonce, query: url.searchParams });

  const responseHeader = encodePaymentResponse({
    scheme: "exact",
    network: deps.network,
    settlement: {
      success: true,
      txHash: result.settlement.txHash,
      blockNumber: result.settlement.blockNumber,
      amount: result.settlement.amountRaw,
      payer: result.settlement.payer,
      payTo: result.settlement.payTo,
      asset: result.settlement.asset,
      settledAt: result.settlement.settledAt,
    },
    receipt: {
      intentId: result.settlement.intentId,
      idempotencyKey: echo.extra.idempotencyKey,
      replay: result.replay,
      deliveredAt: now.toISOString(),
      verifier: verifier.name,
    },
  });

  return new Response(
    JSON.stringify(
      {
        resource,
        paidWith: {
          intentId: result.settlement.intentId,
          txHash: result.settlement.txHash,
          amountRaw: result.settlement.amountRaw,
          amountUSDC: Number(result.settlement.amountRaw) / 1e6,
          replay: result.replay,
        },
        data,
      },
      null,
      2,
    ),
    {
      status: 200,
      headers: {
        ...noStore(),
        [PAYMENT_RESPONSE_HEADER]: responseHeader,
        [IDEMPOTENCY_KEY_HEADER]: result.settlement.intentId,
        "x-payment-network": deps.network,
      },
    },
  );
}

function challenge402(req: Request, deps: ServeX402Deps, resource: string, message: string, code: string): Response {
  const { header, required } = buildChallenge({
    resource,
    spec: deps.spec,
    network: deps.network,
    chainId: deps.chainId,
    asset: deps.asset,
    payTo: deps.payTo,
  });
  return new Response(JSON.stringify({ error: code, message, accepts: required.accepts }, null, 2), {
    status: 402,
    headers: {
      ...noStore(),
      [PAYMENT_REQUIRED_HEADER]: header,
      "x-x402-error": code,
      "x-payment-network": deps.network,
    },
  });
}
