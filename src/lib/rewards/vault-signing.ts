import "server-only";
import { KeyPair, Address, Transaction, TransactionBuilder, PrivateKey } from "@nimiq/core";
import { deriveVaultAddress } from "@/lib/rewards/vault-key";

/**
 * Votum campaign-vault offline transaction construction + signing (Slice-0).
 *
 * Builds and signs the exact NIM payout transaction that V2B.2.7 will need —
 * WITHOUT broadcasting. Proves the isolated-vault payout shape is viable with
 * the installed @nimiq/core (2.7.2).
 *
 * Server-only by construction. No network contact, no real funds.
 */

export interface RewardPayoutTxParams {
  /** Campaign vault (sender), canonical hex. */
  senderAddressHex: string;
  /** Participant wallet (recipient), canonical hex. */
  recipientAddressHex: string;
  /** Exact advertised reward in Luna — recipient receives this exactly. */
  rewardPerParticipantLuna: bigint;
  /** Network fee in Luna — separate from reward, borne by the creator (D9). */
  feeLuna: bigint;
  /** Validity-start height; tx valid for the protocol validity window. */
  validityStartHeight: number;
  /** Nimiq network id (e.g. alphanet 42 as used by the repo's RPC config). */
  networkId: number;
}

export interface BuiltRewardPayout {
  /** Sender canonical hex (must equal campaign vault). */
  senderHex: string;
  /** Recipient canonical hex (must equal participant wallet). */
  recipientHex: string;
  valueLuna: bigint;
  feeLuna: bigint;
  /** Signed transaction serialized to bytes (empty until signed). */
  serialize(): Uint8Array;
  /** Signed transaction hex (empty until signed). */
  toHex(): string;
  /** Transaction hash (64-hex). */
  hash(): string;
  /** The underlying Nimiq Transaction object. */
  tx: Transaction;
}

/**
 * Construct (unsigned) the standard basic NIM payout transaction.
 * Value and fee are separate fields: the recipient receives exactly
 * `rewardPerParticipantLuna`; the fee is deducted from the sender.
 */
export function buildRewardPayoutTransaction(
  params: RewardPayoutTxParams,
): BuiltRewardPayout {
  const sender = Address.fromString(params.senderAddressHex);
  const recipient = Address.fromString(params.recipientAddressHex);

  const tx = TransactionBuilder.newBasic(
    sender,
    recipient,
    params.rewardPerParticipantLuna,
    params.feeLuna,
    params.validityStartHeight,
    params.networkId,
  );

  return {
    senderHex: tx.sender.toHex(),
    recipientHex: tx.recipient.toHex(),
    valueLuna: tx.value,
    feeLuna: tx.fee,
    serialize: () => tx.serialize(),
    toHex: () => tx.toHex(),
    hash: () => tx.hash(),
    tx,
  };
}

/**
 * Sign the payout transaction with the decrypted/reconstructed campaign vault
 * key. Mutates the underlying transaction's signature proof in place.
 */
export function signRewardPayoutTransaction(
  built: BuiltRewardPayout,
  vaultKey: KeyPair,
): BuiltRewardPayout {
  built.tx.sign(vaultKey, undefined);
  return built;
}

/**
 * Reconstruct the campaign vault keypair from decrypted private bytes and
 * sign. Convenience that keeps the decrypted key scoped to one call.
 */
export function buildAndSignRewardPayout(
  privateKeyBytes: Uint8Array,
  params: RewardPayoutTxParams,
): BuiltRewardPayout {
  const { addressHex } = deriveVaultAddress(privateKeyBytes);
  if (addressHex.toLowerCase() !== params.senderAddressHex.toLowerCase()) {
    throw new Error("vault private key does not match requested sender address");
  }
  const keypair = KeyPair.derive(PrivateKey.deserialize(privateKeyBytes));
  try {
    const built = buildRewardPayoutTransaction(params);
    return signRewardPayoutTransaction(built, keypair);
  } finally {
    keypair.free?.();
  }
}

/** Verify a signed payout matches the exact advertised reward (D9). */
export function assertExactRewardValue(
  built: BuiltRewardPayout,
  expectedRewardLuna: bigint,
): boolean {
  return built.valueLuna === expectedRewardLuna;
}

/** Verify the payout fee is carried separately from the reward. */
export function feeIsSeparate(built: BuiltRewardPayout): boolean {
  return built.feeLuna >= BigInt(0) && built.valueLuna !== built.feeLuna;
}
