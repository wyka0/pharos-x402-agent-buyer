import { describe, it, expect, beforeEach } from "vitest";
import { buildChallenge } from "@/lib/server/challenge";
import { ENDPOINT_SPECS } from "@/lib/server/catalog";
import { InMemoryReceiptStore, PaymentVerifier } from "@/lib/server/verifier";
import { bindSettlement, computeIntentId, computeResourceHash } from "@/lib/commitment";
import { buildAuthorization, signAuthorization } from "@/lib/settlement/signer";
import { privateKeyToAccount } from "viem/accounts";
import type { X402PaymentPayload } from "@/lib/x402";
import { makeWorld, PAYER_KEY, PAY_TO, USDC, BASE } from "./helpers";
import { NETWORK_ID, CHAIN_ID } from "@/lib/chain";
import type { Hex } from "viem";

const payer = privateKeyToAccount(PAYER_KEY);
const signer = { address: payer.address, signTypedData: (td: Parameters<typeof payer.signTypedData>[0]) => payer.signTypedData(td) };
const RESOURCE = `${BASE}/api/x402/security-audit`;

interface Built {
  payload: X402PaymentPayload;
  requirements: ReturnType<typeof buildChallenge>["requirements"];
  intentId: Hex;
}

async function buildValidPayload(world: ReturnType<typeof makeWorld>, opts: { resource?: string; priceRaw?: bigint; settleValue?: bigint; nonceGen?: () => Hex; intentSeed?: string } = {}): Promise<Built> {
  const spec = ENDPOINT_SPECS["/api/x402/security-audit"];
  const challenge = buildChallenge({
    resource: opts.resource ?? RESOURCE,
    spec,
    network: NETWORK_ID,
    chainId: CHAIN_ID,
    asset: USDC,
    payTo: PAY_TO,
    nonceGen: opts.nonceGen,
  });
  const requirements = challenge.requirements;
  const price = BigInt(requirements.maxAmountRequired);
  const resourceHash = computeResourceHash(requirements.resource, requirements.maxAmountRequired, PAY_TO);
  const intentId = computeIntentId(opts.intentSeed ?? "verify-test", requirements.resource, 0, resourceHash);
  const authorization = buildAuthorization({ payer: payer.address, payTo: PAY_TO, amountRaw: price, intentId, nowSec: Math.floor(Date.now() / 1000) });
  const signature = await signAuthorization(signer, authorization, USDC);
  const broadcast = await world.broadcaster.broadcastTransferWithAuthorization({
    authorization,
    signature,
    intentId,
  });
  // optionally settle a different amount than challenged (simulates misbehavior):
  // the PRESENTED tx moves `settleValue`, so the on-chain amount check must fail.
  const presentedTx = opts.settleValue !== undefined && opts.settleValue !== price
    ? world.sim.settle({ from: payer.address, to: PAY_TO, value: opts.settleValue, token: USDC, intentId })
    : broadcast.txHash;
  const payload: X402PaymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK_ID,
    resource: requirements.resource,
    requirementsEcho: requirements,
    intentId,
    authorization: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value.toString(),
      validAfter: authorization.validAfter.toString(),
      validBefore: authorization.validBefore.toString(),
      nonce: authorization.nonce,
    },
    signature,
    txHash: presentedTx,
    quoteCommitment: requirements.extra.quoteCommitment,
    settlementCommitment: bindSettlement(requirements.extra.quoteCommitment, presentedTx),
  };
  return { payload, requirements, intentId };
}

let world: ReturnType<typeof makeWorld>;
beforeEach(() => {
  world = makeWorld();
});

describe("Server-side PaymentVerifier — happy path", () => {
  it("verifies a genuine payment and records the settlement receipt", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const result = await world.verifier.verifyPayment(requirements, payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.replay).toBe(false);
      expect(result.settlement.amountRaw).toBe("100000");
      expect(result.settlement.payer.toLowerCase()).toBe(payer.address.toLowerCase());
      expect(result.settlement.payTo).toBe(PAY_TO);
      expect(result.settlement.txHash).toBe(payload.txHash);
      expect(BigInt(result.settlement.blockNumber) > 0n).toBe(true);
    }
  });

  it("is idempotent: re-presenting the same paid proof replays the stored receipt", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const first = await world.verifier.verifyPayment(requirements, payload);
    expect(first.ok && first.replay).toBe(false);
    const second = await world.verifier.verifyPayment(requirements, payload);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.replay).toBe(true);
      expect(second.settlement.txHash).toBe(payload.txHash);
      expect(second.settlement.replayCount).toBe(1);
    }
    const third = await world.verifier.verifyPayment(requirements, payload);
    expect(third.ok && third.replay && third.settlement.replayCount === 2).toBe(true);
  });

  it("stores receipts in the shared store for later audits", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    await world.verifier.verifyPayment(requirements, payload);
    expect(world.receipts.all()).toHaveLength(1);
    expect(world.receipts.getByNonce(payload.authorization.nonce as Hex)?.intentId).toBe(payload.intentId);
  });
});

describe("Server-side PaymentVerifier — tamper detection", () => {
  it("rejects a payload whose echoed price differs from the authorization value", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tamperedEcho = { ...requirements, maxAmountRequired: "999999" };
    const result = await world.verifier.verifyPayment(tamperedEcho, payload);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(["PRICE_MISMATCH", "COMMITMENT_MISMATCH"]).toContain(result.code);
  });

  it("rejects a txHash that was not bound by the settlement commitment", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tampered = { ...payload, txHash: ("0x" + "ff".repeat(32)) as Hex };
    const result = await world.verifier.verifyPayment(requirements, tampered);
    expect(result).toMatchObject({ ok: false, code: "SETTLEMENT_COMMITMENT_MISMATCH" });
  });

  it("rejects a tampered quoteCommitment echo", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tampered = {
      ...payload,
      requirementsEcho: {
        ...requirements,
        extra: { ...requirements.extra, quoteCommitment: ("0x" + "12".repeat(32)) as Hex },
      },
    };
    const result = await world.verifier.verifyPayment(tampered.requirementsEcho, tampered);
    expect(result).toMatchObject({ ok: false, code: "COMMITMENT_MISMATCH" });
  });

  it("rejects an echo whose payTo differs from the verifier's own recipient", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tamperedEcho = { ...requirements, payTo: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C" };
    const result = await world.verifier.verifyPayment(tamperedEcho, payload);
    expect(result).toMatchObject({ ok: false, code: "RECIPIENT_MISMATCH" });
  });

  it("rejects an echo whose asset differs from the configured USDC", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tamperedEcho = { ...requirements, asset: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C" };
    const result = await world.verifier.verifyPayment(tamperedEcho, payload);
    expect(result).toMatchObject({ ok: false, code: "ASSET_MISMATCH" });
  });

  it("rejects a mismatched network", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const tamperedEcho = { ...requirements, network: "eip155:1" };
    const result = await world.verifier.verifyPayment(tamperedEcho, payload);
    expect(result).toMatchObject({ ok: false, code: "NETWORK_MISMATCH" });
  });

  it("rejects a forged EIP-3009 signature", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const impostor = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
    const forged = await impostor.signTypedData({
      domain: { name: "USDC", version: "2", chainId: 688689, verifyingContract: USDC },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: payload.authorization.from as `0x${string}`,
        to: payload.authorization.to as `0x${string}`,
        value: BigInt(payload.authorization.value),
        validAfter: BigInt(payload.authorization.validAfter),
        validBefore: BigInt(payload.authorization.validBefore),
        nonce: payload.authorization.nonce as Hex,
      },
    });
    const result = await world.verifier.verifyPayment(requirements, { ...payload, signature: forged });
    expect(result).toMatchObject({ ok: false, code: "AUTH_SIGNATURE_INVALID" });
  });

  it("rejects an expired authorization window", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const expired = {
      ...payload,
      authorization: { ...payload.authorization, validBefore: "1" },
    };
    const result = await world.verifier.verifyPayment(requirements, expired);
    expect(result).toMatchObject({ ok: false, code: "AUTH_WINDOW_INVALID" });
  });
});

describe("Server-side PaymentVerifier — on-chain proof checks", () => {
  it("rejects an unknown tx (TX_NOT_FOUND)", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const fakeTx = ("0x" + "aa".repeat(32)) as Hex;
    const result = await world.verifier.verifyPayment(requirements, {
      ...payload,
      txHash: fakeTx,
      settlementCommitment: bindSettlement(payload.quoteCommitment, fakeTx),
    });
    expect(result).toMatchObject({ ok: false, code: "TX_NOT_FOUND" });
  });

  it("rejects a reverted settlement tx", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const reverted = world.sim.settle({ from: payer.address, to: PAY_TO, value: 100_000n, token: USDC, intentId: payload.intentId, status: "reverted" });
    const result = await world.verifier.verifyPayment(requirements, {
      ...payload,
      txHash: reverted,
      settlementCommitment: bindSettlement(payload.quoteCommitment, reverted),
    });
    expect(result).toMatchObject({ ok: false, code: "TX_REVERTED" });
  });

  it("rejects an on-chain amount different from the challenge (underpayment)", async () => {
    const { payload, requirements } = await buildValidPayload(world, { settleValue: 50_000n });
    const result = await world.verifier.verifyPayment(requirements, payload);
    expect(result).toMatchObject({ ok: false, code: "AMOUNT_MISMATCH" });
  });

  it("rejects a settlement to the wrong recipient", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const wrongTo = world.sim.settle({ from: payer.address, to: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C", value: 100_000n, token: USDC, intentId: payload.intentId });
    const result = await world.verifier.verifyPayment(requirements, {
      ...payload,
      txHash: wrongTo,
      settlementCommitment: bindSettlement(payload.quoteCommitment, wrongTo),
    });
    expect(result).toMatchObject({ ok: false, code: "WRONG_RECIPIENT_ONCHAIN" });
  });

  it("rejects transfers in a non-USDC token", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const fakeTokenTx = ("0x" + "bb".repeat(32)) as Hex;
    const proberWithWrongToken = {
      name: "wrong-token-prober",
      async chainId() {
        return CHAIN_ID;
      },
      async getPaymentProof(txHash: Hex) {
        if (txHash === fakeTokenTx) {
          return { status: "success" as const, blockNumber: 42n, token: "0x299Ce4113abF88F4997737184aa8A7a3D58AC15C" as Hex, transfer: { from: payer.address, to: PAY_TO, value: 100_000n } };
        }
        return world.prober.getPaymentProof(txHash);
      },
    };
    const verifier = new PaymentVerifier({
      prober: proberWithWrongToken,
      receipts: new InMemoryReceiptStore(),
      payTo: PAY_TO,
      asset: USDC,
      network: NETWORK_ID,
      chainId: CHAIN_ID,
    });
    const result = await verifier.verifyPayment(requirements, {
      ...payload,
      txHash: fakeTokenTx,
      settlementCommitment: bindSettlement(payload.quoteCommitment, fakeTokenTx),
    });
    expect(result).toMatchObject({ ok: false, code: "WRONG_ASSET_ONCHAIN" });
  });

  it("rejects a settlement with no USDC transfer at all", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    const emptyTx = ("0x" + "cc".repeat(32)) as Hex;
    const emptyProber = {
      name: "empty-prober",
      async chainId() {
        return CHAIN_ID;
      },
      async getPaymentProof(txHash: Hex) {
        if (txHash === emptyTx) return { status: "success" as const, blockNumber: 43n, token: null, transfer: null };
        return world.prober.getPaymentProof(txHash);
      },
    };
    const verifier = new PaymentVerifier({
      prober: emptyProber,
      receipts: new InMemoryReceiptStore(),
      payTo: PAY_TO,
      asset: USDC,
      network: NETWORK_ID,
      chainId: CHAIN_ID,
    });
    const result = await verifier.verifyPayment(requirements, {
      ...payload,
      txHash: emptyTx,
      settlementCommitment: bindSettlement(payload.quoteCommitment, emptyTx),
    });
    expect(result).toMatchObject({ ok: false, code: "NO_USDC_TRANSFER" });
  });
});

describe("Server-side PaymentVerifier — idempotency guards", () => {
  it("conflicts when the same intent presents a DIFFERENT txHash after settling", async () => {
    const { payload, requirements } = await buildValidPayload(world);
    await world.verifier.verifyPayment(requirements, payload);
    const otherTx = ("0x" + "dd".repeat(32)) as Hex;
    const result = await world.verifier.verifyPayment(requirements, {
      ...payload,
      txHash: otherTx,
      settlementCommitment: bindSettlement(payload.quoteCommitment, otherTx),
    });
    expect(result).toMatchObject({ ok: false, code: "RECEIPT_CONFLICT" });
  });

  it("rejects a nonce reused by a different intent", async () => {
    const first = await buildValidPayload(world);
    await world.verifier.verifyPayment(first.requirements, first.payload);
    // Second intent re-uses the same authorization nonce
    const second = await buildValidPayload(world);
    const nonceReuse = { ...second.payload, intentId: ("0x" + "9".repeat(64)) as Hex, authorization: { ...second.payload.authorization, nonce: first.payload.authorization.nonce } };
    const result = await world.verifier.verifyPayment(second.requirements, nonceReuse);
    expect(result).toMatchObject({ ok: false, code: "NONCE_REUSED" });
  });

  it("different intents with different nonces both settle independently", async () => {
    const a = await buildValidPayload(world, { nonceGen: () => ("0x" + "01".repeat(32)) as Hex, intentSeed: "intent-a" });
    const b = await buildValidPayload(world, { nonceGen: () => ("0x" + "02".repeat(32)) as Hex, intentSeed: "intent-b" });
    const ra = await world.verifier.verifyPayment(a.requirements, a.payload);
    const rb = await world.verifier.verifyPayment(b.requirements, b.payload);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(world.receipts.all()).toHaveLength(2);
  });
});
