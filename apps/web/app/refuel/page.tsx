"use client";

import { useEffect, useState } from "react";
import { gasBalance, requestRefuel, type RefuelQuoteResult } from "@/lib/api";

/**
 * SPEC §5.5 `/refuel` — four-stage pipeline visualization + gas tank (brand signature).
 * Wallet: injected connector (MetaMask/Coinbase) for the Base side; CIP-30 (Eternl) only
 * to display the Vector address — v1 spends custodially on Vector.
 * NOTE: original apex-refuel.html was missing on this machine (see apps/refuel/README.md);
 * this port follows the SPEC description + §1.4 CFG.
 */
type Stage = 0 | 1 | 2 | 3;
const STAGES = ["USDC on Base", "Swap → bAP3X", "Bridge → Vector", "Gas credited"] as const;

declare global {
  interface Window {
    ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
    cardano?: Record<string, { enable: () => Promise<{ getUsedAddresses: () => Promise<string[]> }> }>;
  }
}

export default function RefuelPage() {
  const [baseAddress, setBaseAddress] = useState<string | null>(null);
  const [vectorAddress, setVectorAddress] = useState("");
  const [usdcAmount, setUsdcAmount] = useState(25);
  const [stage, setStage] = useState<Stage>(0);
  const [result, setResult] = useState<RefuelQuoteResult | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (vectorAddress.length > 8) {
      void gasBalance(vectorAddress).then(setBalance);
    }
  }, [vectorAddress, result]);

  const connectBase = async () => {
    if (!window.ethereum) {
      setError("No injected wallet found — install MetaMask or Coinbase Wallet");
      return;
    }
    try {
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
      setBaseAddress(accounts[0] ?? null);
      // Base mainnet chain switch (chainId 8453 = 0x2105)
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x2105" }],
      }).catch(() => undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const connectEternl = async () => {
    const eternl = window.cardano?.eternl;
    if (!eternl) {
      setError("Eternl not found — used only to display your Vector address (v1 spends custodially)");
      return;
    }
    try {
      const api = await eternl.enable();
      const [addr] = await api.getUsedAddresses();
      if (addr) setVectorAddress(addr);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const refuel = async () => {
    setBusy(true);
    setError(null);
    setStage(0);
    try {
      setStage(1);
      const r = await requestRefuel(usdcAmount, vectorAddress);
      setResult(r);
      setStage(r.swapTx ? 2 : 1);
      if (r.bridge) setStage(2);
      if (r.creditedAp3x != null) setStage(3);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const tankPct = balance === null ? 0 : Math.min(100, (balance / 1000) * 100);

  return (
    <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr]">
      <section>
        <p className="eyebrow mb-2">USDC in · AP3X gas out — the payment abstraction</p>
        <h1 className="font-display text-4xl font-semibold uppercase tracking-wide mb-6">
          Refuel your <span className="text-accent">agents</span>
        </h1>

        {/* four-stage pipeline — the brand signature */}
        <div className="panel p-5 mb-6">
          <div className="flex items-center">
            {STAGES.map((label, i) => (
              <div key={label} className="flex items-center flex-1 last:flex-none">
                <div className="flex flex-col items-center gap-2">
                  <div
                    className={`w-10 h-10 rounded-full border flex items-center justify-center font-display font-semibold
                      ${i <= stage && result ? "border-accent text-accent" : "border-line text-ink-3"}
                      ${i === stage && busy ? "animate-pulse" : ""}`}
                  >
                    {i + 1}
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3 text-center w-24">{label}</span>
                </div>
                {i < STAGES.length - 1 && (
                  <div className={`h-px flex-1 mx-1 mb-6 ${i < stage && result ? "bg-accent" : "bg-line"}`} />
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="panel p-5 space-y-4">
          <div className="flex flex-wrap gap-3">
            <button onClick={connectBase} className="btn-ghost">
              {baseAddress ? `Base: ${baseAddress.slice(0, 6)}…${baseAddress.slice(-4)}` : "Connect Base wallet"}
            </button>
            <button onClick={connectEternl} className="btn-ghost">
              {vectorAddress ? "Vector address set ✓" : "Show Vector address (Eternl)"}
            </button>
          </div>
          <input
            value={vectorAddress}
            onChange={(e) => setVectorAddress(e.target.value)}
            placeholder="Vector gas address (vector_…)"
            className="w-full bg-void border border-line rounded-sm p-3 font-mono text-xs focus:border-accent outline-none"
          />
          <div className="flex items-center gap-4">
            <label className="eyebrow flex items-center gap-2">
              USDC
              <input
                type="number"
                value={usdcAmount}
                min={1}
                onChange={(e) => setUsdcAmount(Number(e.target.value))}
                className="w-28 bg-void border border-line rounded-sm px-2 py-1 font-mono text-sm text-ink"
              />
            </label>
            <button onClick={refuel} disabled={busy || vectorAddress.length < 8} className="btn-gold ml-auto">
              {busy ? "Quoting…" : "Refuel"}
            </button>
          </div>
          {error && <p className="font-mono text-xs text-warn">{error}</p>}
        </div>

        {result && (
          <div className="panel p-5 mt-6 space-y-2 font-mono text-xs">
            <p className="eyebrow mb-2">{result.live ? "Executed" : "Dry-run quote (REFUEL_LIVE=false)"}</p>
            <p>
              {result.quote.usdcIn} USDC → <span className="text-accent">{result.quote.bap3xOut.toFixed(4)} bAP3X</span>{" "}
              <span className="text-ink-3">(min {result.quote.minBap3xOut.toFixed(4)} @ {result.quote.slippageBps} bps)</span>
            </p>
            {result.swapTx && <p>swap: {result.swapTx}</p>}
            {result.bridge?.deepLink && (
              <p>
                bridge ({result.bridge.state}):{" "}
                <a className="text-accent underline" href={result.bridge.deepLink} target="_blank" rel="noreferrer">
                  complete on Skyline ↗
                </a>{" "}
                <span className="text-ink-3">— bridge API pending (BLOCKER-1); guided handoff mode</span>
              </p>
            )}
            {result.creditedAp3x != null && <p className="text-good">credited {result.creditedAp3x.toFixed(4)} AP3X gas</p>}
          </div>
        )}
      </section>

      <aside className="space-y-6">
        {/* gas tank */}
        <div className="panel p-5">
          <p className="eyebrow mb-3">Gas tank</p>
          <div className="relative h-44 border border-line rounded-sm overflow-hidden bg-void">
            <div
              className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-accent/80 to-accent/40 transition-all duration-700"
              style={{ height: `${tankPct}%` }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-display text-3xl font-bold">{balance === null ? "—" : balance.toFixed(1)}</span>
              <span className="eyebrow">AP3X gas</span>
            </div>
          </div>
          <p className="font-mono text-[10px] text-ink-3 mt-2">balance for {vectorAddress ? `${vectorAddress.slice(0, 16)}…` : "(set address)"}</p>
        </div>

        <div className="panel p-5">
          <p className="eyebrow mb-2">x402 micropayments</p>
          <p className="font-body text-sm text-ink-2 leading-relaxed">
            Agents can top up per-call: hit <code className="font-mono text-accent">/api/refuel/v1/gas/topup</code>, get an HTTP
            402 challenge, sign an EIP-3009 USDC authorization, retry with <code className="font-mono">X-PAYMENT</code>. Settled
            through the facilitator; gas credits land here.
          </p>
        </div>
      </aside>
    </div>
  );
}
