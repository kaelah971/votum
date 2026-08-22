import { describe, it, expect } from "vitest";
import { KeyPair, Transaction } from "@nimiq/core";
import {
  buildRewardPayoutTransaction,
  signRewardPayoutTransaction,
  buildAndSignRewardPayout,
  assertExactRewardValue,
  feeIsSeparate,
  type RewardPayoutTxParams,
} from "@/lib/rewards/vault-signing";
import { generateVaultKey, disposeVaultKey } from "@/lib/rewards/vault-key";
import { MIN_REWARD_PER_PARTICIPANT_LUNA, ESTIMATED_TX_FEE_LUNA } from "@/lib/rewards/constants";

const NETWORK_ID = 42; // alphanet, as configured by NIMIQ_NETWORK_ID in the repo
const VALIDITY_START = 1;

function makeParams(
  senderHex: string,
  recipientHex: string,
  rewardLuna: bigint = BigInt(50000),
  feeLuna: bigint = ESTIMATED_TX_FEE_LUNA,
): RewardPayoutTxParams {
  return {
    senderAddressHex: senderHex,
    recipientAddressHex: recipientHex,
    rewardPerParticipantLuna: rewardLuna,
    feeLuna,
    validityStartHeight: VALIDITY_START,
    networkId: NETWORK_ID,
  };
}

describe("offline reward payout construction", () => {
  it("builds a standard basic transaction with sender = vault, recipient = participant", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex()),
      );
      expect(built.senderHex).toBe(vault.addressHex);
      expect(built.recipientHex).toBe(participant.toAddress().toHex());
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("carries the exact advertised reward in Luna (no fee subtraction)", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const reward = BigInt(50000); // 0.5 NIM
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex(), reward),
      );
      expect(built.valueLuna).toBe(reward);
      expect(assertExactRewardValue(built, reward)).toBe(true);
      expect(feeIsSeparate(built)).toBe(true);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("supports the minimum reward (1,000 Luna)", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex(), MIN_REWARD_PER_PARTICIPANT_LUNA),
      );
      expect(built.valueLuna).toBe(MIN_REWARD_PER_PARTICIPANT_LUNA);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("represents the network fee separately per Nimiq semantics", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const fee = BigInt(4000);
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex(), BigInt(50000), fee),
      );
      expect(built.feeLuna).toBe(fee);
      expect(built.valueLuna).not.toBe(built.feeLuna);
      expect(built.tx.fee).toBe(fee);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("sets the network id and validity-start height explicitly", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex()),
      );
      expect(built.tx.networkId).toBe(NETWORK_ID);
      expect(built.tx.validityStartHeight).toBe(VALIDITY_START);
      // Validity window is a known policy value.
      expect(built.tx.validityStartHeight).toBeGreaterThan(0);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });
});

describe("offline signing", () => {
  it("signs and produces a non-empty serialized transaction", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex()),
      );
      const unsignedSize = built.serialize().length;
      const signed = signRewardPayoutTransaction(built, vault.keypair);
      const serialized = signed.serialize();
      expect(serialized.length).toBeGreaterThan(0);
      expect(serialized.length).toBeGreaterThan(unsignedSize);
      expect(signed.toHex().length).toBeGreaterThan(0);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("signed tx sender still corresponds to the vault and value is exact", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const reward = BigInt(50000);
      const built = buildRewardPayoutTransaction(
        makeParams(vault.addressHex, participant.toAddress().toHex(), reward),
      );
      const signed = signRewardPayoutTransaction(built, vault.keypair);
      const parsed = Transaction.fromAny(signed.tx);
      expect(parsed.sender.toHex()).toBe(vault.addressHex);
      expect(parsed.recipient.toHex()).toBe(participant.toAddress().toHex());
      expect(parsed.value).toBe(reward);
      expect(parsed.fee).toBe(BigInt(4000));
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("buildAndSign (key reconstruction from private bytes) works", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const signed = buildAndSignRewardPayout(vault.privateKeyBytes, makeParams(
        vault.addressHex,
        participant.toAddress().toHex(),
      ));
      expect(signed.senderHex).toBe(vault.addressHex);
      expect(signed.hash()).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });

  it("rejects signing when the key does not match the requested sender", () => {
    const vaultA = generateVaultKey();
    const vaultB = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      expect(() =>
        buildAndSignRewardPayout(vaultA.privateKeyBytes, makeParams(
          vaultB.addressHex,
          participant.toAddress().toHex(),
        )),
      ).toThrow(/does not match/);
    } finally {
      disposeVaultKey(vaultA);
      disposeVaultKey(vaultB);
      participant.free?.();
    }
  });

  it("serialization round-trips a signed transaction to the same hash", () => {
    const vault = generateVaultKey();
    const participant = KeyPair.generate();
    try {
      const signed = buildAndSignRewardPayout(vault.privateKeyBytes, makeParams(
        vault.addressHex,
        participant.toAddress().toHex(),
      ));
      const parsed = Transaction.deserialize(signed.serialize());
      expect(parsed.hash()).toBe(signed.hash());
    } finally {
      disposeVaultKey(vault);
      participant.free?.();
    }
  });
});
