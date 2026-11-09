import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, service: "pharos-x402-agent-buyer", time: new Date().toISOString() });
}
