import { describe, it, expect } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildAuthorization,
  signAuthorization,
  verifyAuthorizationSignature,
  authorizationTypedData,
  isAuthorizationWindowValid,
  type SignerLike,
} from "@/lib/settlement/signer";
import { computeIntentId, computeResourceHash } from "@/lib/commitment";
import { PAYER_KEY, PAY_TO, USDC } from "./helpers";

const payer = privateKeyToAccount(PAYER_KEY);
const signer: SignerLike = { address: payer.address, signTypedData: (td) => payer.signTypedData(td) };

function authFor(intentId: `0x${string}`, nowSec = 1_800_000_000) {
  return buildAuthorization({ payer: payer.address, payTo: PAY_TO, amountRaw: 100_000n, intentId, nowSec });
}

const intentId = computeIntentId("run-1", "http://test.local/api/x402/security-audit", 0, computeResourceHash("http://test.local/api/x402/security-audit", "100000", PAY_TO));

describe("EIP-3009 authorization building", () => {
  it("builds the exact challenged amount and recipient", () => {
    const auth = authFor(intentId);
    expect(auth.value).toBe(100_000n);
    expect(auth.to).toBe(PAY_TO);
    expect(auth.from).toBe(payer.address);
  });

  it("derives the nonce deterministically from the intentId (chain-level replay protection)", () => {
    const a1 = authFor(intentId);
    const a2 = authFor(intentId);
    expect(a1.nonce).toBe(a2.nonce);
    expect(a1.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses different nonces for different intents", () => {
    const other = computeIntentId("run-2", "http://test.local/api/x402/whale-telemetry", 0, computeResourceHash("http://test.local/api/x402/whale-telemetry", "150000", PAY_TO));
    expect(authFor(other).nonce).not.toBe(authFor(intentId).nonce);
  });

  it("applies a sane validity window (validAfter < now < validBefore)", () => {
    const now = 1_800_000_000;
    const auth = authFor(intentId, now);
    expect(auth.validAfter < BigInt(now)).toBe(true);
    expect(auth.validBefore > BigInt(now)).toBe(true);
    expect(auth.validBefore - auth.validAfter).toBeGreaterThanOrEqual(900n);
  });

  it("respects a custom ttl", () => {
    const auth = buildAuthorization({ payer: payer.address, payTo: PAY_TO, amountRaw: 1n, intentId, nowSec: 1_800_000_000, ttlSec: 60 });
    expect(auth.validBefore - auth.validAfter).toBeLessThanOrEqual(1360n);
  });
});

describe("EIP-3009 signing and verification", () => {
  it("signs with the USDC v2 domain (name USDC, version 2, chainId 688689)", async () => {
    const auth = authFor(intentId);
    const td = authorizationTypedData(auth, USDC);
    expect(td.domain).toEqual({ name: "USDC", version: "2", chainId: 688689, verifyingContract: USDC });
    expect(td.primaryType).toBe("TransferWithAuthorization");
  });

  it("produces a 65-byte signature that recovers to the payer", async () => {
    const auth = authFor(intentId);
    const signature = await signAuthorization(signer, auth, USDC);
    expect(signature).toMatch(/^0x[0-9a-fA-F]{130}$/);
    const ok = await verifyAuthorizationSignature({ auth, signature, verifyingContract: USDC });
    expect(ok).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const impostor = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const auth = authFor(intentId);
    const forged = await impostor.signTypedData(authorizationTypedData(auth, USDC));
    const ok = await verifyAuthorizationSignature({ auth, signature: forged, verifyingContract: USDC });
    expect(ok).toBe(false);
  });

  it("rejects a signature over tampered parameters", async () => {
    const auth = authFor(intentId);
    const signature = await signAuthorization(signer, auth, USDC);
    const tampered = { ...auth, value: 999_999n };
    const ok = await verifyAuthorizationSignature({ auth: tampered, signature, verifyingContract: USDC });
    expect(ok).toBe(false);
  });

  it("rejects a signature under a different domain (wrong verifyingContract)", async () => {
    const auth = authFor(intentId);
    const signature = await signAuthorization(signer, auth, USDC);
    const ok = await verifyAuthorizationSignature({
      auth,
      signature,
      verifyingContract: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C",
    });
    expect(ok).toBe(false);
  });

  it("validates the authorization window helper", () => {
    const now = 1_800_000_000;
    const auth = authFor(intentId, now);
    expect(isAuthorizationWindowValid(auth, now)).toBe(true);
    expect(isAuthorizationWindowValid(auth, now + 3600)).toBe(false); // expired
    expect(isAuthorizationWindowValid(auth, now - 4000)).toBe(false); // not yet valid
  });

  it("signatures are deterministic for the same authorization (no randomness)", async () => {
    const auth = authFor(intentId);
    const s1 = await signAuthorization(signer, auth, USDC);
    const s2 = await signAuthorization(signer, auth, USDC);
    expect(s1).toBe(s2);
  });
});
