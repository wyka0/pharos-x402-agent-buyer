import { describe, it, expect } from "vitest";
import { SimulatedChain, createSimulatedBroadcastAdapter, transferWithAuthorizationCalldata, sharedSimulatedChain } from "@/lib/settlement/broadcast";
import { buildAuthorization, signAuthorization } from "@/lib/settlement/signer";
import { privateKeyToAccount } from "viem/accounts";
import { toFunctionSelector } from "viem";
import { computeIntentId, computeResourceHash } from "@/lib/commitment";
import { PAYER_KEY, PAY_TO, USDC, BASE } from "./helpers";

const payer = privateKeyToAccount(PAYER_KEY);
const signer = { address: payer.address, signTypedData: (td: Parameters<typeof payer.signTypedData>[0]) => payer.signTypedData(td) };
const intentId = computeIntentId("run-broadcast", `${BASE}/api/x402/security-audit`, 0, computeResourceHash(`${BASE}/api/x402/security-audit`, "100000", PAY_TO));

async function signedAuth(amountRaw = 100_000n) {
  const authorization = buildAuthorization({ payer: payer.address, payTo: PAY_TO, amountRaw, intentId, nowSec: 1_800_000_000 });
  const signature = await signAuthorization(signer, authorization, USDC);
  return { authorization, signature };
}

describe("SimulatedChain (zero-risk demo settlement)", () => {
  it("registers settlements retrievable as payment proofs", () => {
    const sim = new SimulatedChain();
    const txHash = sim.settle({ from: payer.address, to: PAY_TO, value: 100_000n, token: USDC, intentId });
    const proof = sim.getProof(txHash);
    expect(proof).not.toBeNull();
    expect(proof!.status).toBe("success");
    expect(proof!.from).toBe(payer.address);
    expect(proof!.to).toBe(PAY_TO);
    expect(proof!.value).toBe(100_000n);
    expect(proof!.token).toBe(USDC);
  });

  it("returns null for unknown tx hashes", () => {
    const sim = new SimulatedChain();
    expect(sim.getProof(("0x" + "ff".repeat(32)) as `0x${string}`)).toBeNull();
  });

  it("produces deterministic, distinct, valid tx hashes", () => {
    const sim = new SimulatedChain();
    const h1 = sim.settle({ from: payer.address, to: PAY_TO, value: 1n, token: USDC, intentId });
    const h2 = sim.settle({ from: payer.address, to: PAY_TO, value: 2n, token: USDC, intentId });
    expect(h1).not.toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sim.settle({ from: payer.address, to: PAY_TO, value: 1n, token: USDC, intentId })).toBe(h1);
  });

  it("advances block numbers per settlement", () => {
    const sim = new SimulatedChain();
    const b0 = sim.blockNumber;
    sim.settle({ from: payer.address, to: PAY_TO, value: 1n, token: USDC, intentId });
    expect(sim.blockNumber).toBeGreaterThan(b0);
  });

  it("keeps a global singleton shared across consumers", () => {
    expect(sharedSimulatedChain()).toBe(sharedSimulatedChain());
  });
});

describe("Simulated broadcast adapter", () => {
  it("broadcasts and confirms with matching proofs", async () => {
    const sim = new SimulatedChain();
    const adapter = createSimulatedBroadcastAdapter({ chain: sim, payer: payer.address, usdc: USDC });
    const { authorization, signature } = await signedAuth();
    const result = await adapter.broadcastTransferWithAuthorization({ authorization, signature, intentId });
    expect(result.strategy).toBe("eip3009");
    expect(adapter.broadcastCount).toBe(1);
    const receipt = await adapter.waitForReceipt(result.txHash);
    expect(receipt.status).toBe("success");
    expect(typeof receipt.blockNumber).toBe("bigint");
    const proof = sim.getProof(result.txHash);
    expect(proof?.value).toBe(100_000n);
    expect(proof?.to).toBe(PAY_TO);
  });

  it("increments broadcastCount per call (used for the exactly-once assertions)", async () => {
    const sim = new SimulatedChain();
    const adapter = createSimulatedBroadcastAdapter({ chain: sim, payer: payer.address, usdc: USDC });
    const { authorization, signature } = await signedAuth(1n);
    await adapter.broadcastTransferWithAuthorization({ authorization, signature, intentId });
    await adapter.broadcastTransferWithAuthorization({ authorization, signature, intentId });
    expect(adapter.broadcastCount).toBe(2);
  });

  it("throws when waiting for a receipt that was never broadcast", async () => {
    const adapter = createSimulatedBroadcastAdapter({ chain: new SimulatedChain(), payer: payer.address, usdc: USDC });
    await expect(adapter.waitForReceipt(("0x" + "ee".repeat(32)) as `0x${string}`)).rejects.toThrow(/unknown tx/);
  });
});

describe("calldata parity helper", () => {
  it("encodes transferWithAuthorization with the signed V/R/S", async () => {
    const { authorization, signature } = await signedAuth();
    const data = transferWithAuthorizationCalldata(authorization, signature);
    expect(data).toMatch(/^0x[a-f0-9]+$/);
    const expectedSelector = toFunctionSelector(
      "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    );
    expect(data.slice(0, 10)).toBe(expectedSelector);
  });
});
