import { describe, it, expect } from "vitest";
import { computeQuoteCommitment, bindSettlement, computeResourceHash, computeIntentId, nonceFromIntentId, challengeIdempotencyKey } from "@/lib/commitment";
import type { Hex } from "@/lib/x402";

const base = {
  scheme: "exact",
  network: "eip155:688689",
  resource: "http://test.local/api/x402/security-audit",
  asset: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
  payTo: "0xB0f7681668f916eEd97dA066D31aA295D34727c0",
  maxAmountRequired: "100000",
  chainId: 688689,
  nonce: ("0x" + "ab".repeat(32)) as Hex,
};

describe("Innovation #1: quote-to-settlement commitments", () => {
  it("computes a deterministic 32-byte quoteCommitment", () => {
    const c1 = computeQuoteCommitment(base);
    const c2 = computeQuoteCommitment(base);
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when the price changes (anti bait-and-switch)", () => {
    const different = computeQuoteCommitment({ ...base, maxAmountRequired: "100001" });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the recipient changes", () => {
    const different = computeQuoteCommitment({ ...base, payTo: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C" });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the resource changes", () => {
    const different = computeQuoteCommitment({ ...base, resource: "http://test.local/api/x402/whale-telemetry" });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the nonce changes", () => {
    const different = computeQuoteCommitment({ ...base, nonce: ("0x" + "cd".repeat(32)) as Hex });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the chainId changes", () => {
    const different = computeQuoteCommitment({ ...base, chainId: 688688 });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the asset changes", () => {
    const different = computeQuoteCommitment({ ...base, asset: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C" });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("changes when the network changes", () => {
    const different = computeQuoteCommitment({ ...base, network: "eip155:1" });
    expect(different).not.toBe(computeQuoteCommitment(base));
  });

  it("binds the settlement: keccak(quoteCommitment, txHash)", () => {
    const qc = computeQuoteCommitment(base);
    const tx1 = ("0x" + "55".repeat(32)) as Hex;
    const s1 = bindSettlement(qc, tx1);
    expect(s1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bindSettlement(qc, tx1)).toBe(s1);
    const tx2 = ("0x" + "56".repeat(32)) as Hex;
    expect(bindSettlement(qc, tx2)).not.toBe(s1);
    expect(bindSettlement(computeQuoteCommitment({ ...base, maxAmountRequired: "999999" }), tx1)).not.toBe(s1);
  });

  it("computes a stable resourceHash from (resource, price, payTo)", () => {
    const h1 = computeResourceHash(base.resource, "100000", base.payTo);
    expect(h1).toBe(computeResourceHash(base.resource, "100000", base.payTo));
    expect(computeResourceHash(base.resource, "150000", base.payTo)).not.toBe(h1);
    expect(computeResourceHash("http://other", "100000", base.payTo)).not.toBe(h1);
  });

  it("derives deterministic intentIds from (taskRunId, url, step, resourceHash)", () => {
    const rh = computeResourceHash(base.resource, "100000", base.payTo);
    const id1 = computeIntentId("run-1", "http://test.local/api/x402/security-audit", 0, rh);
    expect(id1).toBe(computeIntentId("run-1", "http://test.local/api/x402/security-audit", 0, rh));
    expect(computeIntentId("run-2", "http://test.local/api/x402/security-audit", 0, rh)).not.toBe(id1);
    expect(computeIntentId("run-1", "http://test.local/api/x402/whale-telemetry", 0, rh)).not.toBe(id1);
    expect(computeIntentId("run-1", "http://test.local/api/x402/security-audit", 1, rh)).not.toBe(id1);
    expect(computeIntentId("run-1", "http://test.local/api/x402/security-audit", 0, computeResourceHash(base.resource, "100001", base.payTo))).not.toBe(id1);
  });

  it("derives the EIP-3009 nonce deterministically from the intentId", () => {
    const id = computeIntentId("run-1", "http://x", 0, computeResourceHash(base.resource, "1", base.payTo));
    expect(nonceFromIntentId(id)).toBe(nonceFromIntentId(id));
    expect(nonceFromIntentId(id)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(nonceFromIntentId(computeIntentId("run-2", "http://x", 0, computeResourceHash(base.resource, "1", base.payTo)))).not.toBe(nonceFromIntentId(id));
  });

  it("derives per-challenge idempotency keys from (resource, nonce)", () => {
    const k1 = challengeIdempotencyKey(base.resource, base.nonce);
    expect(k1).toBe(challengeIdempotencyKey(base.resource, base.nonce));
    expect(challengeIdempotencyKey(base.resource, ("0x" + "cd".repeat(32)) as Hex)).not.toBe(k1);
  });

  it("never produces equal commitments for different structured inputs", () => {
    const variants = [
      base,
      { ...base, scheme: "other" },
      { ...base, maxAmountRequired: "1000000" },
      { ...base, chainId: 1 },
    ];
    const set = new Set(variants.map((v) => computeQuoteCommitment(v)));
    expect(set.size).toBe(variants.length);
  });
});
