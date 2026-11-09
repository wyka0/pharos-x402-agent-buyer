import { describe, it, expect } from "vitest";
import type { Hex } from "viem";
import {
  toBase64,
  fromBase64,
  encodePaymentRequired,
  decodePaymentRequired,
  encodePaymentPayload,
  decodePaymentPayload,
  encodePaymentResponse,
  decodePaymentResponse,
  X402HeaderError,
  type X402PaymentRequired,
  type X402PaymentPayload,
  type X402PaymentResponse,
} from "@/lib/x402";

function sampleRequired(): X402PaymentRequired {
  return {
    x402Version: 2,
    accepts: [
      {
        x402Version: 2,
        scheme: "exact",
        network: "eip155:688689",
        asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
        payTo: "0xB0f7681668f916eEd97dA066D31aA295D34727c0",
        maxAmountRequired: "100000",
        resource: "http://test.local/api/x402/security-audit",
        description: "audit",
        mimeType: "application/json",
        maxTimeoutSeconds: 60,
        extra: {
          name: "USDC",
          version: "2",
          chainId: 688689,
          nonce: ("0x" + "ab".repeat(32)) as Hex,
          idempotencyKey: ("0x" + "cd".repeat(32)) as Hex,
          quoteCommitment: ("0x" + "11".repeat(32)) as Hex,
          advertisedUtility: { valueUSDC: "0.20", expectedSignals: 12 },
        },
      },
    ],
  };
}

export function samplePayload(overrides: Partial<X402PaymentPayload> = {}): X402PaymentPayload {
  return {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:688689",
    resource: "http://test.local/api/x402/security-audit",
    requirementsEcho: sampleRequired().accepts[0],
    intentId: ("0x" + "22".repeat(32)) as Hex,
    authorization: {
      from: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C",
      to: "0xB0f7681668f916eEd97dA066D31aA295D34727c0",
      value: "100000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: ("0x" + "33".repeat(32)) as Hex,
    },
    signature: ("0x" + "44".repeat(65)) as Hex,
    txHash: ("0x" + "55".repeat(32)) as Hex,
    quoteCommitment: ("0x" + "11".repeat(32)) as Hex,
    settlementCommitment: ("0x" + "66".repeat(32)) as Hex,
    ...overrides,
  };
}

export function sampleResponse(): X402PaymentResponse {
  return {
    scheme: "exact",
    network: "eip155:688689",
    settlement: {
      success: true,
      txHash: ("0x" + "55".repeat(32)) as Hex,
      blockNumber: "123",
      amount: "100000",
      payer: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C",
      payTo: "0xB0f7681668f916eEd97dA066D31aA295D34727c0",
      asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
      settledAt: "2026-01-01T00:00:00.000Z",
    },
    receipt: {
      intentId: ("0x" + "22".repeat(32)) as Hex,
      idempotencyKey: "0x" + "cd".repeat(32),
      replay: false,
      deliveredAt: "2026-01-01T00:00:01.000Z",
      verifier: "test-verifier",
    },
  };
}

describe("x402 headers: base64 codec", () => {
  it("round-trips utf-8 text through base64", () => {
    const text = 'PAYMENT-REQUIRED {"hello":"wörld ✓"}';
    expect(fromBase64(toBase64(text))).toBe(text);
  });

  it("round-trips emoji and multibyte content", () => {
    const text = "🔐🔐🔐 micropayments";
    expect(fromBase64(toBase64(text))).toBe(text);
  });

  it("rejects non-base64 garbage with a coded error", () => {
    expect(() => fromBase64("not valid base64!!!")).toThrow(X402HeaderError);
    try {
      fromBase64("###");
    } catch (e) {
      expect((e as X402HeaderError).code).toBe("MALFORMED_BASE64");
    }
  });
});

describe("x402 headers: PAYMENT-REQUIRED", () => {
  it("encodes to base64 and decodes back losslessly", () => {
    const header = encodePaymentRequired(sampleRequired());
    expect(header).not.toContain("{");
    const decoded = decodePaymentRequired(header);
    expect(decoded).toEqual(sampleRequired());
  });

  it("produces a header of reasonable size (< 4KB)", () => {
    const header = encodePaymentRequired(sampleRequired());
    expect(header.length).toBeGreaterThan(100);
    expect(header.length).toBeLessThan(4096);
  });

  it("rejects wrong x402Version", () => {
    const bad = sampleRequired() as unknown as Record<string, unknown>;
    bad.x402Version = 1;
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/x402Version/);
  });

  it("rejects empty accepts array", () => {
    const bad = { x402Version: 2, accepts: [] };
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/accepts/);
  });

  it("rejects non-exact scheme", () => {
    const bad = sampleRequired();
    bad.accepts[0].scheme = "upton" as never;
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/scheme/);
  });

  it("rejects non-CAIP2 network", () => {
    const bad = sampleRequired();
    bad.accepts[0].network = "pharos-mainnet";
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/network/);
  });

  it("rejects malformed maxAmountRequired (must be decimal string)", () => {
    const bad = sampleRequired();
    (bad.accepts[0].maxAmountRequired as unknown as number) = 100000;
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/maxAmountRequired/);
  });

  it("rejects missing quoteCommitment", () => {
    const bad = sampleRequired();
    delete (bad.accepts[0].extra as Record<string, unknown>).quoteCommitment;
    expect(() => decodePaymentRequired(btoa(JSON.stringify(bad)))).toThrow(/quoteCommitment/);
  });

  it("rejects undecodable JSON inside base64", () => {
    const garbage = btoa("this is not json");
    expect(() => decodePaymentRequired(garbage)).toThrow(X402HeaderError);
  });

  it("rejects base64 of JSON of a string", () => {
    expect(() => decodePaymentRequired(btoa('"just a string"'))).toThrow(X402HeaderError);
  });
});

describe("x402 headers: PAYMENT-SIGNATURE", () => {
  it("round-trips the full payload losslessly", () => {
    const header = encodePaymentPayload(samplePayload());
    expect(decodePaymentPayload(header)).toEqual(samplePayload());
  });

  it("rejects a 31-byte txHash", () => {
    const bad = samplePayload({ txHash: ("0x" + "55".repeat(31)) as `0x${string}` });
    expect(() => decodePaymentPayload(btoa(JSON.stringify(bad)))).toThrow(/txHash/);
  });

  it("rejects a non-hex intentId", () => {
    const p = samplePayload();
    p.intentId = "intent-123" as never;
    expect(() => decodePaymentPayload(btoa(JSON.stringify(p)))).toThrow(/intentId/);
  });

  it("rejects missing authorization", () => {
    const p = samplePayload() as unknown as Record<string, unknown>;
    delete p.authorization;
    expect(() => decodePaymentPayload(btoa(JSON.stringify(p)))).toThrow(/authorization/);
  });

  it("rejects a 20-byte authorization nonce", () => {
    const p = samplePayload();
    (p.authorization.nonce as unknown as string) = "0x" + "33".repeat(20);
    expect(() => decodePaymentPayload(btoa(JSON.stringify(p)))).toThrow(/nonce/);
  });

  it("rejects non-decimal authorization value", () => {
    const p = samplePayload();
    (p.authorization.value as unknown as string) = "0.1";
    expect(() => decodePaymentPayload(btoa(JSON.stringify(p)))).toThrow(/value|validAfter|validBefore/);
  });
});

describe("x402 headers: PAYMENT-RESPONSE", () => {
  it("round-trips the settlement receipt losslessly", () => {
    const header = encodePaymentResponse(sampleResponse());
    expect(decodePaymentResponse(header)).toEqual(sampleResponse());
  });

  it("rejects a settlement without success flag", () => {
    const bad = sampleResponse();
    (bad.settlement as unknown as Record<string, unknown>).success = "yes";
    expect(() => decodePaymentResponse(btoa(JSON.stringify(bad)))).toThrow(/settlement/);
  });

  it("rejects a receipt without replay flag", () => {
    const bad = sampleResponse();
    delete (bad.receipt as unknown as Record<string, unknown>).replay;
    expect(() => decodePaymentResponse(btoa(JSON.stringify(bad)))).toThrow(/receipt/);
  });

  it("rejects a non-32-byte settlement txHash", () => {
    const bad = sampleResponse();
    (bad.settlement.txHash as unknown as string) = "0xdeadbeef";
    expect(() => decodePaymentResponse(btoa(JSON.stringify(bad)))).toThrow(/txHash/);
  });
});
