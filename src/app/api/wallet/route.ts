import { NextResponse } from "next/server";
import { createPublicClient, http, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { payToFromEnv, payerKeyFromEnv, rpcUrlFromEnv, pharosAtlantic, usdcAddressFromEnv } from "@/lib/chain";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

/** Server wallet status — the private key NEVER leaves the server. */
export async function GET() {
  const key = payerKeyFromEnv();
  if (!key) {
    return NextResponse.json({ configured: false, message: "TEST_USER_PRIVATE_KEY not set — simulated mode only." });
  }
  try {
    const account = privateKeyToAccount(key);
    const pub = createPublicClient({ chain: pharosAtlantic(rpcUrlFromEnv()), transport: http(rpcUrlFromEnv()) });
    const [phrs, usdc] = await Promise.all([
      pub.getBalance({ address: account.address }),
      pub.readContract({ address: usdcAddressFromEnv(), abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }),
    ]);
    let payToUsdc: bigint | null = null;
    try {
      payToUsdc = await pub.readContract({ address: usdcAddressFromEnv(), abi: ERC20_ABI, functionName: "balanceOf", args: [payToFromEnv()] });
    } catch {
      payToUsdc = null;
    }
    return NextResponse.json({
      configured: true,
      buyer: { address: account.address, phrs: formatUnits(phrs, 18), usdc: formatUnits(usdc, 6) },
      payTo: { address: payToFromEnv(), usdc: payToUsdc !== null ? formatUnits(payToUsdc, 6) : null },
      rpcUrl: rpcUrlFromEnv(),
    });
  } catch (e) {
    return NextResponse.json({ configured: false, error: String(e) }, { status: 200 });
  }
}
