/**
 * Fault-injection simulator for the buyer's HTTP plane (Requirement 04).
 *
 * Faults are injected CLIENT-side, i.e. in the agent's own fetch wrapper, which
 * is exactly where a flaky network / dying connection manifests. The classic
 * dangerous window is "payment already broadcast, response never arrives" —
 * the agent must recover with the SAME payment proof, never a second tx.
 */
import type { Hex } from "../x402";

export type FaultPhase = "initial_request" | "delivery_attempt";
export type FaultType = "drop_connection" | "http_502" | "http_503" | "timeout";

export interface FaultRule {
  /** Substring matched against the request URL. */
  endpointMatch: string;
  phase: FaultPhase;
  /** 1-based delivery-attempt (or request) number the fault first fires on. */
  fromAttempt?: number;
  /** How many times the fault fires before letting traffic through. */
  times: number;
  type: FaultType;
}

export interface FaultOccurrence {
  rule: FaultRule;
  attempt: number;
  at: string;
}

export class SimulatedNetworkError extends Error {
  constructor(readonly type: FaultType, readonly url: string, readonly attempt: number) {
    super(`Simulated ${type} while calling ${url} (attempt ${attempt})`);
    this.name = "SimulatedNetworkError";
  }
}

export class FaultInjector {
  private counters = new Map<string, number>();
  readonly fired: FaultOccurrence[] = [];

  constructor(private readonly rules: FaultRule[] = []) {}

  /**
   * Applies matching rules for the given (url, phase, attempt). Returns either a
   * synthetic error response, a thrown SimulatedNetworkError marker, or null.
   */
  apply(url: string, phase: FaultPhase, attempt: number): Response | "network_error" | null {
    for (const rule of this.rules) {
      if (!url.includes(rule.endpointMatch)) continue;
      if (rule.phase !== phase) continue;
      const from = rule.fromAttempt ?? 1;
      if (attempt < from) continue;
      const key = `${rule.endpointMatch}|${rule.phase}|${rule.type}`;
      const firedCount = this.counters.get(key) ?? 0;
      if (firedCount >= rule.times) continue;
      this.counters.set(key, firedCount + 1);
      this.fired.push({ rule, attempt, at: new Date().toISOString() });
      if (rule.type === "drop_connection" || rule.type === "timeout") return "network_error";
      return new Response(JSON.stringify({ error: `simulated_${rule.type}` }), {
        status: rule.type === "http_502" ? 502 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    return null;
  }

  stats(): { rules: number; fired: number } {
    return { rules: this.rules.length, fired: this.fired.length };
  }
}
