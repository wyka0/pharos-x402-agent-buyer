import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "x402 Agent Buyer — Pharos Atlantic",
  description:
    "Autonomous x402 Buyer Agent on Pharos Atlantic Testnet (688689): budget-gated, ROI-ranked, idempotent micropayments with cryptographic quote-to-settlement commitments.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
