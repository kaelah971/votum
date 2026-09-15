import "server-only";
import { KeyPair, Address } from "@nimiq/core";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  VAULT_ENVELOPE_VERSION,
  encryptVaultKey,
  decryptVaultKey,
  generateVaultKey,
  deriveVaultAddress,
  reconstructVaultKey,
  getVaultMasterKey,
  disposeVaultKey,
  bytesEqual,
  type VaultAadContext,
} from "@/lib/rewards/vault-key";

/**
 * Votum persisted settlement-vault lifecycle (V2C.2E).
 *
 * Server-only by construction. Encrypts the campaign vault private key at rest
 * (AES-256-GCM, campaign-bound AAD) in the dedicated reward_campaign_vaults
 * table. Exactly one vault per settlement. The key never leaves the server, is
 * never returned in outward shapes, and is decrypted only transiently inside
 * `withRewardSettlementVaultKey`.
 *
 * No transaction signing/broadcasting happens here.
 */

export interface SettlementVaultPublic {
  settlementId: string;
  /** Poll compatibility campaign ID; absent for a standalone Campaign root. */
  campaignId: string | null;
  vaultAddressHex: string;
  vaultAddressNq: string;
  /** true when this call created the vault, false when it already existed. */
  created: boolean;
}

/** @deprecated Use SettlementVaultPublic and settlementId-based APIs. */
export interface CampaignVaultPublic {
  campaignId: string;
  vaultAddressHex: string;
  vaultAddressNq: string;
  /** true when this call created the vault, false when it already existed. */
  created: boolean;
}

export interface CampaignVaultRow {
  settlement_id: string;
  campaign_id: string | null;
  vault_address_hex: string;
  envelope_version: string;
  encryption_algorithm: string;
  encrypted_private_key_ciphertext: string;
  encryption_iv: string;
  authentication_tag: string;
}

export class VaultIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultIntegrityError";
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ALLOWED_PRE_FUNDING_STATES = ["configured", "funding_pending"] as const;

function requireMasterKey(): Buffer {
  return getVaultMasterKey(); // throws when missing/invalid (fail closed)
}

async function loadSettlementState(settlementId: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) throw new Error("admin client unavailable");
  const { data, error } = await admin
    .from("reward_settlements")
    .select("status")
    .eq("id", settlementId)
    .maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}

async function loadVaultRow(settlementId: string): Promise<CampaignVaultRow | null> {
  const admin = createAdminClient();
  if (!admin) throw new Error("admin client unavailable");
  const { data, error } = await admin
    .from("reward_campaign_vaults")
    .select("*")
    .eq("settlement_id", settlementId)
    .maybeSingle();
  if (error) throw error;
  return (data as CampaignVaultRow) ?? null;
}

function aadFor(settlementId: string, vaultAddressHex: string): VaultAadContext {
  return { settlementId, vaultAddressHex };
}

function nqFromHex(hex: string): string {
  return Address.fromString(hex).toUserFriendlyAddress();
}

function toSettlementPublic(row: CampaignVaultRow, created: boolean): SettlementVaultPublic {
  return {
    settlementId: row.settlement_id,
    campaignId: row.campaign_id,
    vaultAddressHex: row.vault_address_hex,
    vaultAddressNq: nqFromHex(row.vault_address_hex),
    created,
  };
}

function toCampaignPublic(row: SettlementVaultPublic): CampaignVaultPublic {
  return {
    campaignId: row.campaignId ?? row.settlementId,
    vaultAddressHex: row.vaultAddressHex,
    vaultAddressNq: row.vaultAddressNq,
    created: row.created,
  };
}

// ---------------------------------------------------------------------------
// Public service API (safe outward shapes — no ciphertext, no keys)
// ---------------------------------------------------------------------------

/**
 * Ensure a campaign has exactly one persisted vault. Returns ONLY safe public
 * vault metadata (campaign id + public addresses). Never returns ciphertext or
 * key material. Idempotent and race-safe (see the atomic RPC).
 */
export async function ensureRewardSettlementVault(settlementId: string): Promise<SettlementVaultPublic> {
  requireMasterKey(); // fail closed if not provisioned

  const state = await loadSettlementState(settlementId);
  if (state === null) throw new Error("settlement_not_found");
  if (!(ALLOWED_PRE_FUNDING_STATES as readonly string[]).includes(state)) {
    throw new Error(`settlement_state_invalid:${state}`);
  }

  // Fast path: an authoritative vault already exists.
  const existingRow = await loadVaultRow(settlementId);
  if (existingRow) {
    return toSettlementPublic(existingRow, false);
  }

  // Generate a candidate server-side, encrypt with campaign-bound AAD.
  const candidate = generateVaultKey();
  try {
    const masterKey = requireMasterKey();
    const envelope = encryptVaultKey(
      candidate.privateKeyBytes,
      masterKey,
      aadFor(settlementId, candidate.addressHex),
    );

    const admin = createAdminClient();
    if (!admin) throw new Error("admin client unavailable");

     const { data, error } = await admin.rpc("ensure_reward_settlement_vault_atomic", {
       _settlement_id: settlementId,
      _vault_address_hex: candidate.addressHex,
      _envelope_version: VAULT_ENVELOPE_VERSION,
      _encryption_algorithm: envelope.algorithm,
      _ciphertext: envelope.ciphertext,
      _iv: envelope.iv,
      _auth_tag: envelope.authTag,
    });
    if (error) throw error;

    const result = data as { result_kind: string; vault_address_hex: string };

    // The authoritative row may be our candidate (created) or a concurrent
    // winner (existing). If another process won, our candidate is discarded —
    // never returned, never persisted.
     const row = await loadVaultRow(settlementId);
     if (!row) throw new Error("vault_row_missing_after_ensure");
     return toSettlementPublic(row, result.result_kind === "created");
  } finally {
    disposeVaultKey(candidate);
  }
}

/**
 * Compatibility wrapper for existing Poll callers. The argument is now a
 * settlement ID; the returned campaignId is derived from the persisted Poll
 * binding rather than used as vault identity.
 */
export async function ensureCampaignVault(settlementId: string): Promise<CampaignVaultPublic> {
  try {
    return toCampaignPublic(await ensureRewardSettlementVault(settlementId));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("settlement_not_found")) {
      throw new Error("campaign_not_found");
    }
    if (error instanceof Error && error.message.startsWith("settlement_state_invalid")) {
      throw new Error(error.message.replace("settlement_state_invalid", "campaign_state_invalid"));
    }
    throw error;
  }
}

/**
 * Load a persisted vault's public metadata only (no ciphertext).
 */
export async function getRewardSettlementVault(settlementId: string): Promise<SettlementVaultPublic | null> {
  const row = await loadVaultRow(settlementId);
  return row ? toSettlementPublic(row, false) : null;
}

/** @deprecated Use getRewardSettlementVault. */
export async function getCampaignVault(settlementId: string): Promise<CampaignVaultPublic | null> {
  const row = await getRewardSettlementVault(settlementId);
  return row ? toCampaignPublic(row) : null;
}

/**
 * Decrypt a persisted vault, reconstruct the keypair, verify the derived
 * address matches the persisted address (fail closed on mismatch), run the
 * callback with the keypair scoped tightly inside, then dispose references.
 *
 * Never returns the keypair or key material through the application layer.
 */
export async function withRewardSettlementVaultKey<T>(
  settlementId: string,
  callback: (keypair: KeyPair) => T | Promise<T>,
): Promise<T> {
  const masterKey = requireMasterKey();
  const row = await loadVaultRow(settlementId);
  if (!row) throw new Error("vault_not_found");

  const plaintext = decryptVaultKey(
    {
      version: row.envelope_version as typeof VAULT_ENVELOPE_VERSION,
      algorithm: row.encryption_algorithm as "aes-256-gcm",
      iv: row.encryption_iv,
      ciphertext: row.encrypted_private_key_ciphertext,
      authTag: row.authentication_tag,
    },
    masterKey,
    aadFor(settlementId, row.vault_address_hex),
  );

  // Address self-check: derived address MUST equal persisted address.
  const derived = deriveVaultAddress(plaintext);
  if (derived.addressHex.toLowerCase() !== row.vault_address_hex.toLowerCase()) {
    plaintext.fill(0);
    throw new VaultIntegrityError(
      "vault address mismatch: derived key does not match persisted vault address",
    );
  }

  const keypair = reconstructVaultKey(plaintext);
  plaintext.fill(0);
  try {
    return await callback(keypair);
  } finally {
    keypair.free?.();
  }
}

/** @deprecated Use withRewardSettlementVaultKey. */
export async function withCampaignVaultKey<T>(
  settlementId: string,
  callback: (keypair: KeyPair) => T | Promise<T>,
): Promise<T> {
  return withRewardSettlementVaultKey(settlementId, callback);
}

/** Verify a derived address equals a persisted vault address (exported helper). */
export function vaultAddressMatches(persisted: string, derived: string): boolean {
  return bytesEqual(
    Buffer.from(persisted.toLowerCase(), "hex"),
    Buffer.from(derived.toLowerCase(), "hex"),
  );
}
