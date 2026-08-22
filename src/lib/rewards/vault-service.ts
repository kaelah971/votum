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
 * Votum persisted campaign-vault lifecycle (V2B.2.2B).
 *
 * Server-only by construction. Encrypts the campaign vault private key at rest
 * (AES-256-GCM, campaign-bound AAD) in the dedicated reward_campaign_vaults
 * table. Exactly one vault per campaign. The key never leaves the server, is
 * never returned in outward shapes, and is decrypted only transiently inside
 * `withCampaignVaultKey`.
 *
 * No transaction signing/broadcasting happens here.
 */

export interface CampaignVaultPublic {
  campaignId: string;
  vaultAddressHex: string;
  vaultAddressNq: string;
  /** true when this call created the vault, false when it already existed. */
  created: boolean;
}

export interface CampaignVaultRow {
  campaign_id: string;
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

async function loadCampaignState(campaignId: string): Promise<string | null> {
  const admin = createAdminClient();
  if (!admin) throw new Error("admin client unavailable");
  const { data, error } = await admin
    .from("reward_campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return data?.status ?? null;
}

async function loadVaultRow(campaignId: string): Promise<CampaignVaultRow | null> {
  const admin = createAdminClient();
  if (!admin) throw new Error("admin client unavailable");
  const { data, error } = await admin
    .from("reward_campaign_vaults")
    .select("*")
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (error) throw error;
  return (data as CampaignVaultRow) ?? null;
}

function aadFor(campaignId: string, vaultAddressHex: string): VaultAadContext {
  return { campaignId, vaultAddressHex };
}

function nqFromHex(hex: string): string {
  return Address.fromString(hex).toUserFriendlyAddress();
}

function toPublic(row: CampaignVaultRow, created: boolean): CampaignVaultPublic {
  return {
    campaignId: row.campaign_id,
    vaultAddressHex: row.vault_address_hex,
    vaultAddressNq: nqFromHex(row.vault_address_hex),
    created,
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
export async function ensureCampaignVault(campaignId: string): Promise<CampaignVaultPublic> {
  requireMasterKey(); // fail closed if not provisioned

  const state = await loadCampaignState(campaignId);
  if (state === null) throw new Error("campaign_not_found");
  if (!(ALLOWED_PRE_FUNDING_STATES as readonly string[]).includes(state)) {
    throw new Error(`campaign_state_invalid:${state}`);
  }

  // Fast path: an authoritative vault already exists.
  const existingRow = await loadVaultRow(campaignId);
  if (existingRow) {
    return toPublic(existingRow, false);
  }

  // Generate a candidate server-side, encrypt with campaign-bound AAD.
  const candidate = generateVaultKey();
  try {
    const masterKey = requireMasterKey();
    const envelope = encryptVaultKey(
      candidate.privateKeyBytes,
      masterKey,
      aadFor(campaignId, candidate.addressHex),
    );

    const admin = createAdminClient();
    if (!admin) throw new Error("admin client unavailable");

    const { data, error } = await admin.rpc("ensure_reward_campaign_vault_atomic", {
      _campaign_id: campaignId,
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
    const row = await loadVaultRow(campaignId);
    if (!row) throw new Error("vault_row_missing_after_ensure");
    return toPublic(row, result.result_kind === "created");
  } finally {
    disposeVaultKey(candidate);
  }
}

/**
 * Load a persisted vault's public metadata only (no ciphertext).
 */
export async function getCampaignVault(campaignId: string): Promise<CampaignVaultPublic | null> {
  const row = await loadVaultRow(campaignId);
  return row ? toPublic(row, false) : null;
}

/**
 * Decrypt a persisted vault, reconstruct the keypair, verify the derived
 * address matches the persisted address (fail closed on mismatch), run the
 * callback with the keypair scoped tightly inside, then dispose references.
 *
 * Never returns the keypair or key material through the application layer.
 */
export async function withCampaignVaultKey<T>(
  campaignId: string,
  callback: (keypair: KeyPair) => T | Promise<T>,
): Promise<T> {
  const masterKey = requireMasterKey();
  const row = await loadVaultRow(campaignId);
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
    aadFor(campaignId, row.vault_address_hex),
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

/** Verify a derived address equals a persisted vault address (exported helper). */
export function vaultAddressMatches(persisted: string, derived: string): boolean {
  return bytesEqual(
    Buffer.from(persisted.toLowerCase(), "hex"),
    Buffer.from(derived.toLowerCase(), "hex"),
  );
}
