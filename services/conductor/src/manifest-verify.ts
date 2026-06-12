import { blake2b } from "blakejs";
import vds from "@cardano-foundation/cardano-verify-datasignature";
import { getPublicKeyFromCoseKey } from "@stricahq/cip08";
import type { AgentManifest } from "@apex/core";

// UMD bundle exports a bare function; its .d.ts doesn't expose a call signature under NodeNext
const verifyDataSignature = vds as unknown as (signature: string, key: string, message?: string, address?: string) => boolean;

/**
 * BLOCKER-3 completion — CIP-8/CIP-30 manifest signature verification.
 * Operators sign the canonical manifest message with the wallet that owns the agent's
 * registry UTxO (CIP-30 `signData`), producing {signature: COSE_Sign1 hex, key: COSE_Key hex}.
 * A manifest is trusted iff (a) the COSE signature verifies and (b) blake2b-224 of the
 * signing public key equals the agent's on-chain ownerPkh.
 */

/** Canonical signed message — keep field order stable; clients must sign exactly this. */
export function manifestMessage(manifest: Pick<AgentManifest, "agentId" | "endpoint" | "pricing">): string {
  return JSON.stringify({
    apexManifestV: 1,
    agentId: manifest.agentId,
    endpoint: { type: manifest.endpoint.type, url: manifest.endpoint.url },
    pricing: { model: manifest.pricing.model, amountAp3x: manifest.pricing.amountAp3x },
  });
}

export interface ManifestVerification {
  valid: boolean;
  reason?: "bad_signature" | "owner_mismatch" | "malformed";
  signerPkh?: string;
}

export function verifyManifest(manifest: AgentManifest, ownerPkh: string): ManifestVerification {
  try {
    const message = manifestMessage(manifest);
    // cryptographic validity of the COSE_Sign1 over the canonical message
    const sigOk = verifyDataSignature(manifest.signature, manifest.publicKey, message);
    if (!sigOk) return { valid: false, reason: "bad_signature" };

    // ownership: blake2b-224(signing key) must equal the registry datum's ownerPkh
    const publicKey: Buffer = getPublicKeyFromCoseKey(manifest.publicKey);
    const signerPkh = Buffer.from(blake2b(publicKey, undefined, 28)).toString("hex");
    if (!ownerPkh || signerPkh.toLowerCase() !== ownerPkh.toLowerCase()) {
      return { valid: false, reason: "owner_mismatch", signerPkh };
    }
    return { valid: true, signerPkh };
  } catch {
    return { valid: false, reason: "malformed" };
  }
}
