import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { signTransferAuthorization, verifyTransferAuthorization, type TransferAuthorization } from "./eip3009.js";
import { ADDRESSES, USDC_EIP3009_DOMAIN } from "./constants.js";

// SPEC §11 — golden-vector test of EIP-3009 signature against the §5.3 domain.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const; // well-known test key
const account = privateKeyToAccount(PK);

function auth(overrides: Partial<TransferAuthorization> = {}): TransferAuthorization {
  return {
    from: account.address,
    to: "0x1111111111111111111111111111111111111111",
    value: "5000000", // 5 USDC
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"ab".repeat(32)}` as `0x${string}`,
    ...overrides,
  };
}

describe("EIP-3009", () => {
  it("uses the exact SPEC §5.3 domain", () => {
    expect(USDC_EIP3009_DOMAIN).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: ADDRESSES.USDC,
    });
  });

  it("sign → verify round-trip", async () => {
    const signed = await signTransferAuthorization(account, auth());
    expect(signed.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await verifyTransferAuthorization(signed, 1_000_000)).toEqual({ valid: true });
  });

  it("rejects signer mismatch", async () => {
    const signed = await signTransferAuthorization(account, auth());
    signed.authorization.from = "0x2222222222222222222222222222222222222222";
    const v = await verifyTransferAuthorization(signed, 1_000_000);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe("signer_mismatch");
  });

  it("rejects expired and not-yet-valid windows", async () => {
    const expired = await signTransferAuthorization(account, auth({ validBefore: "100" }));
    expect((await verifyTransferAuthorization(expired, 1_000_000)).reason).toBe("expired");
    const early = await signTransferAuthorization(account, auth({ validAfter: "2000000000" }));
    expect((await verifyTransferAuthorization(early, 1_000_000)).reason).toBe("not_yet_valid");
  });

  it("signature is deterministic for the golden vector", async () => {
    const signed = await signTransferAuthorization(account, auth());
    const again = await signTransferAuthorization(account, auth());
    expect(signed.signature).toBe(again.signature);
  });
});
