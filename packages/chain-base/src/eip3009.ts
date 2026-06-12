import type { Account } from "viem";
import { recoverTypedDataAddress } from "viem";
import { USDC_EIP3009_DOMAIN } from "./constants.js";

/** EIP-3009 TransferWithAuthorization typed data (SPEC §5.3 domain, verbatim). */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface TransferAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // uint256 as decimal string (USDC base units)
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface SignedAuthorization {
  authorization: TransferAuthorization;
  signature: `0x${string}`;
}

export async function signTransferAuthorization(
  account: Account,
  auth: TransferAuthorization,
): Promise<SignedAuthorization> {
  if (!account.signTypedData) throw new Error("account does not support signTypedData");
  const signature = await account.signTypedData({
    domain: USDC_EIP3009_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return { authorization: auth, signature };
}

/** Server-side verification: recover signer and check it matches `from`, window valid. */
export async function verifyTransferAuthorization(
  signed: SignedAuthorization,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<{ valid: boolean; reason?: string }> {
  const { authorization: auth, signature } = signed;
  if (nowSec <= Number(auth.validAfter)) return { valid: false, reason: "not_yet_valid" };
  if (nowSec >= Number(auth.validBefore)) return { valid: false, reason: "expired" };
  const recovered = await recoverTypedDataAddress({
    domain: USDC_EIP3009_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature,
  });
  if (recovered.toLowerCase() !== auth.from.toLowerCase()) return { valid: false, reason: "signer_mismatch" };
  return { valid: true };
}
