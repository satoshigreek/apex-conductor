import { describe, expect, it } from "vitest";
import { blake2b } from "blakejs";
import { CoseSign1 } from "@stricahq/cip08";
import pkg from "@stricahq/bip32ed25519";
import type { AgentManifest } from "@apex/core";
import { manifestMessage, verifyManifest } from "./manifest-verify.js";

const { PrivateKey } = pkg as unknown as typeof import("@stricahq/bip32ed25519");

/** Build a real CIP-8 signature the way a CIP-30 wallet's signData does. */
function signManifest(manifest: Pick<AgentManifest, "agentId" | "endpoint" | "pricing">, seed: number) {
  const keyBytes = Buffer.alloc(32, seed);
  const privateKey = new PrivateKey(keyBytes);
  const publicKey = privateKey.toPublicKey().toBytes();

  const message = Buffer.from(manifestMessage(manifest), "utf8");
  const protectedMap = new Map<unknown, unknown>([[1, -8]]); // alg: EdDSA
  const cose = new CoseSign1({ protectedMap, unProtectedMap: new Map(), payload: message });
  const signature = privateKey.sign(cose.createSigStructure());
  const signatureHex = cose.buildMessage(signature).toString("hex");

  // COSE_Key {1:1(OKP), 3:-8(EdDSA), -1:6(Ed25519), -2:pubkey}
  const coseKeyHex = "a4" + "0101" + "0327" + "2006" + "215820" + Buffer.from(publicKey).toString("hex");
  const ownerPkh = Buffer.from(blake2b(publicKey, undefined, 28)).toString("hex");
  return { signatureHex, coseKeyHex, ownerPkh };
}

function manifest(over: Partial<AgentManifest> = {}): AgentManifest {
  return {
    agentId: "policy.assetname",
    endpoint: { type: "https", url: "https://agent.example" },
    pricing: { model: "per_call", amountAp3x: 2 },
    signature: "replaced",
    publicKey: "replaced",
    ...over,
  };
}

describe("verifyManifest (CIP-8, BLOCKER-3)", () => {
  it("accepts a manifest signed by the owner key", () => {
    const m = manifest();
    const { signatureHex, coseKeyHex, ownerPkh } = signManifest(m, 7);
    const result = verifyManifest({ ...m, signature: signatureHex, publicKey: coseKeyHex }, ownerPkh);
    expect(result).toEqual({ valid: true, signerPkh: ownerPkh });
  });

  it("rejects when signed by a different key (owner_mismatch)", () => {
    const m = manifest();
    const { signatureHex, coseKeyHex } = signManifest(m, 7);
    const { ownerPkh: otherPkh } = signManifest(m, 9);
    const result = verifyManifest({ ...m, signature: signatureHex, publicKey: coseKeyHex }, otherPkh);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("owner_mismatch");
  });

  it("rejects when the manifest content was tampered after signing (bad_signature)", () => {
    const m = manifest();
    const { signatureHex, coseKeyHex, ownerPkh } = signManifest(m, 7);
    const tampered = { ...m, endpoint: { type: "https" as const, url: "https://evil.example" } };
    const result = verifyManifest({ ...tampered, signature: signatureHex, publicKey: coseKeyHex }, ownerPkh);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("bad_signature");
  });

  it("rejects garbage without throwing", () => {
    const result = verifyManifest(manifest({ signature: "00", publicKey: "00" }), "abc");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed");
  });

  it("manifestMessage is canonical and order-stable", () => {
    const a = manifestMessage(manifest());
    expect(a).toBe(
      '{"apexManifestV":1,"agentId":"policy.assetname","endpoint":{"type":"https","url":"https://agent.example"},"pricing":{"model":"per_call","amountAp3x":2}}',
    );
  });
});
