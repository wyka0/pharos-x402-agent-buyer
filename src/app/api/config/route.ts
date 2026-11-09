import { NextResponse } from "next/server";
import { CHAIN_ID, NETWORK_ID, NETWORK_NAME, DEFAULT_RPC_URL, explorerUrlFromEnv } from "@/lib/chain";
import { endpointCatalogForUi } from "@/lib/server/catalog";

export async function GET() {
  return NextResponse.json({
    chain: {
      id: CHAIN_ID,
      networkId: NETWORK_ID,
      name: NETWORK_NAME,
      rpcUrl: DEFAULT_RPC_URL,
      explorerUrl: explorerUrlFromEnv(),
      usdc: "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B",
      x402Version: 2,
      scheme: "exact",
    },
    endpoints: endpointCatalogForUi(),
    demos: {
      A: { budgetUSDC: "0.30", perCallCapUSDC: "0.25", expectedStatus: "COMPLETED" },
      B: { budgetUSDC: "0.20", perCallCapUSDC: "0.18", expectedStatus: "HALTED_BUDGET_EXCEEDED" },
    },
  });
}
