"use client";

import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { pharosAtlantic, DEFAULT_RPC_URL } from "./chain";

/**
 * Optional browser-wallet support (wagmi v2). Demos run server-side and do NOT
 * require a connected wallet; this enables an optional "connect" panel that
 * reads the visitor's own Atlantic balances.
 */
export const wagmiConfig = createConfig({
  chains: [pharosAtlantic(DEFAULT_RPC_URL)],
  connectors: [injected({ shimDisconnect: true })],
  transports: {
    [688689]: http(DEFAULT_RPC_URL),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
