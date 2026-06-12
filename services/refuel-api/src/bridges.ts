/**
 * SPEC §5.4 — Bridge adapter interface, the blocker isolator.
 * BRIDGE_MODE=handoff (default) | api | oft. Flipping to `api` is config-only once
 * Skyline/Reactor APIs ship.
 */
export interface BridgeQuote {
  amountInBap3x: string;
  estimatedOutAp3x: string;
  etaSeconds: number | null;
  mode: "handoff" | "api" | "oft";
}

export interface BridgeRequest {
  amountBap3x: string;
  fromAddress: string;
  toVectorAddress: string;
}

export interface BridgeStatus {
  id: string;
  state: "pending_manual" | "submitted" | "confirmed" | "failed";
  detail?: string;
  deepLink?: string;
}

export interface BridgeAdapter {
  readonly mode: "handoff" | "api" | "oft";
  quote(amountBap3x: string): Promise<BridgeQuote>;
  bridge(req: BridgeRequest): Promise<{ id: string; status: BridgeStatus }>;
  status(id: string): Promise<BridgeStatus>;
}

/** Fallback while BLOCKER-1/2 stand: returns a deep-link; the step is marked manual. */
export class HandoffAdapter implements BridgeAdapter {
  readonly mode = "handoff" as const;
  private pending = new Map<string, BridgeStatus>();
  private counter = 0;

  constructor(private skylineUrl = "https://skylinebridge.tech") {}

  async quote(amountBap3x: string): Promise<BridgeQuote> {
    return { amountInBap3x: amountBap3x, estimatedOutAp3x: amountBap3x, etaSeconds: null, mode: "handoff" };
  }

  async bridge(req: BridgeRequest): Promise<{ id: string; status: BridgeStatus }> {
    const id = `handoff_${++this.counter}_${Date.now()}`;
    const deepLink = `${this.skylineUrl}/?amount=${encodeURIComponent(req.amountBap3x)}&to=${encodeURIComponent(req.toVectorAddress)}`;
    const status: BridgeStatus = {
      id,
      state: "pending_manual",
      detail: "Skyline/Reactor APIs not yet released (BLOCKER-1/2) — complete the bridge in the opened tab; gas credit applies on confirmation.",
      deepLink,
    };
    this.pending.set(id, status);
    return { id, status };
  }

  async status(id: string): Promise<BridgeStatus> {
    return this.pending.get(id) ?? { id, state: "failed", detail: "unknown handoff id" };
  }

  /** ops hook: mark a manual handoff confirmed (operator console, M4) */
  confirm(id: string): void {
    const status = this.pending.get(id);
    if (status) status.state = "confirmed";
  }
}

// TODO(blocker-1): SkylineApiAdapter — implement against the Skyline bridge API when released.
export class SkylineApiAdapter implements BridgeAdapter {
  readonly mode = "api" as const;
  constructor(private apiUrl: string) {
    if (!apiUrl) throw new Error("SKYLINE_API is required for BRIDGE_MODE=api");
  }
  async quote(): Promise<BridgeQuote> {
    throw new Error("TODO(blocker-1): Skyline API not yet released — use BRIDGE_MODE=handoff");
  }
  async bridge(): Promise<{ id: string; status: BridgeStatus }> {
    throw new Error("TODO(blocker-1): Skyline API not yet released — use BRIDGE_MODE=handoff");
  }
  async status(): Promise<BridgeStatus> {
    throw new Error("TODO(blocker-1): Skyline API not yet released — use BRIDGE_MODE=handoff");
  }
}

// TODO(blocker-4): OftAdapter — confirm with Ethernal whether bAP3X OFT can send toward Prime
// directly or must route Base→Prime (Skyline) →Vector (Reactor). Reserved; default assumption
// per SPEC §5.4 is the two-hop route.
export class OftAdapter implements BridgeAdapter {
  readonly mode = "oft" as const;
  async quote(): Promise<BridgeQuote> {
    throw new Error("TODO(blocker-4): OFT path to Prime unconfirmed — ask Ethernal");
  }
  async bridge(): Promise<{ id: string; status: BridgeStatus }> {
    throw new Error("TODO(blocker-4): OFT path to Prime unconfirmed — ask Ethernal");
  }
  async status(): Promise<BridgeStatus> {
    throw new Error("TODO(blocker-4): OFT path to Prime unconfirmed — ask Ethernal");
  }
}

export function createBridgeAdapter(mode: "handoff" | "api" | "oft", skylineApi?: string): BridgeAdapter {
  switch (mode) {
    case "handoff":
      return new HandoffAdapter();
    case "api":
      return new SkylineApiAdapter(skylineApi ?? "");
    case "oft":
      return new OftAdapter();
  }
}
