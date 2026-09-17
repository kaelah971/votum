import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  deriveAddressFromPublicKey,
  normalizeAddress,
  verifyNimiqMiniAppSignature,
} from "@/lib/nimiq/server-crypto";
import { getServerOrigin } from "@/lib/api/origin";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

/** Pinned claim action for every Public Giveaway challenge message. */
export const CAMPAIGN_CLAIM_ACTION = "campaign_claim" as const;
/** Pinned claim message version. */
export const CAMPAIGN_CLAIM_VERSION = 1 as const;
/** Challenge lifetime, matching the wallet-proof challenge discipline. */
export const CLAIM_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ClaimChallengeErrorCode =
  | "invalid_request"
  | "campaign_not_found"
  | "service_unavailable";

export class CampaignClaimChallengeError extends Error {
  readonly code: ClaimChallengeErrorCode;

  constructor(code: ClaimChallengeErrorCode, message: string) {
    super(message);
    this.name = "CampaignClaimChallengeError";
    this.code = code;
  }
}

export interface BuildCampaignClaimMessageInput {
  campaignId: string;
  participantWallet: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  origin: string;
}

export type ClaimSignatureReasonCode =
  | "challenge_not_found"
  | "challenge_expired"
  | "challenge_consumed"
  | "wallet_mismatch"
  | "campaign_mismatch"
  | "invalid_signature";

export type ClaimSignatureVerification =
  | { kind: "ok"; participantWallet: string }
  | { kind: "error"; reasonCode: ClaimSignatureReasonCode };

function errorResult(reasonCode: ClaimSignatureReasonCode): ClaimSignatureVerification {
  return { kind: "error", reasonCode };
}

/**
 * Deterministic claim message. Field order, labels, and blank lines are
 * fixed; the exact returned bytes are what the wallet must sign. Binds the
 * Campaign, the canonical claimant wallet, the pinned action/version, the
 * single-use nonce, the lifetime window, and the origin. Carries no amount,
 * settlement, vault, recipient, or other financial terms.
 */
export function buildCampaignClaimMessage(input: BuildCampaignClaimMessageInput): string {
  return [
    "Votum campaign claim",
    "",
    `Campaign: ${input.campaignId}`,
    `Address: ${input.participantWallet}`,
    `Action: ${CAMPAIGN_CLAIM_ACTION}`,
    `Version: ${String(CAMPAIGN_CLAIM_VERSION)}`,
    `Nonce: ${input.nonce}`,
    `Issued at: ${input.issuedAt}`,
    `Expires at: ${input.expiresAt}`,
    `Domain: ${input.origin}`,
    "",
    "This signature authorizes one claim for this campaign only.",
    "It does not send NIM or approve payments.",
  ].join("\n");
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

/**
 * Issue a one-time claim challenge for the session wallet. Stores only the
 * SHA-256 nonce hash and returns exactly the data the client needs to sign.
 * Never writes `consumed_at`: that column means "consumed by the
 * authoritative atomic claim transaction" and is written only by the future
 * slice-D reservation commit. Earlier unconsumed challenges for the same
 * Campaign and wallet therefore stay valid until their own expiry. Performs
 * no eligibility screening beyond Campaign existence: courtesy screening
 * lives at the issue route, and the authoritative decision lives in the
 * future atomic claim transaction. A valid challenge is authorization, not
 * a reservation.
 */
export async function issueCampaignClaimChallenge(
  admin: AdminClient,
  input: { campaignId: string; sessionAddress: string },
): Promise<{ challengeId: string; message: string; expiresAt: string }> {
  const participantWallet = normalizeAddress(input.sessionAddress);
  if (!participantWallet || !input.campaignId) {
    throw new CampaignClaimChallengeError("invalid_request", "Invalid claim challenge request.");
  }

  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (campaignError) {
    throw new CampaignClaimChallengeError("service_unavailable", "Claim challenge store unavailable.");
  }
  if (!campaign) {
    throw new CampaignClaimChallengeError("campaign_not_found", "Campaign not found.");
  }

  const nonce = randomBytes(32).toString("base64url");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CLAIM_CHALLENGE_TTL_MS).toISOString();
  const origin = getServerOrigin() ?? "localhost";
  const message = buildCampaignClaimMessage({
    campaignId: input.campaignId,
    participantWallet,
    nonce,
    issuedAt,
    expiresAt,
    origin,
  });

  const { data: inserted, error: insertError } = await admin
    .from("campaign_claim_challenges")
    .insert({
      campaign_id: input.campaignId,
      participant_wallet: participantWallet,
      nonce_hash: hashNonce(nonce),
      action: CAMPAIGN_CLAIM_ACTION,
      version: CAMPAIGN_CLAIM_VERSION,
      message,
      issued_at: issuedAt,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (insertError || !inserted) {
    throw new CampaignClaimChallengeError("service_unavailable", "Could not create the claim challenge.");
  }

  return { challengeId: inserted.id, message, expiresAt };
}

interface ChallengeRow {
  id: string;
  campaign_id: string;
  participant_wallet: string;
  nonce_hash: string;
  action: string;
  version: number;
  message: string;
  issued_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Verify a claim signature against its stored challenge without mutating
 * anything. Checks existence, single-use state, expiry against server time,
 * Campaign binding, wallet binding (including public-key-derived address),
 * pinned action/version scope, and finally the Nimiq signature over the
 * exact stored message bytes. Fail-closed with generic reason codes and no
 * field-oracle detail. Never sets `consumed_at`: authoritative consumption
 * belongs to the future atomic claim transaction together with reservation.
 *
 * When `options.deferConsumedCheck` is set, the consumed_at rejection is
 * skipped while every cryptographic and binding check still runs. Only the
 * atomic claim transaction may use this mode: it owns the
 * consumed-vs-replay distinction (existing receipt replays, otherwise
 * challenge_consumed) and must see already-consumed challenges to replay
 * exact retries. All other callers use the default fail-closed behavior.
 */
export async function verifyCampaignClaimSignature(
  admin: AdminClient,
  input: {
    challengeId: string;
    campaignId: string;
    address: string;
    publicKey: string;
    signature: string;
  },
  options?: {
    deferConsumedCheck?: boolean;
  },
): Promise<ClaimSignatureVerification> {
  if (!input.challengeId || !input.campaignId) return errorResult("challenge_not_found");

  const { data, error } = await admin
    .from("campaign_claim_challenges")
    .select("id, campaign_id, participant_wallet, nonce_hash, action, version, message, issued_at, expires_at, consumed_at")
    .eq("id", input.challengeId)
    .maybeSingle();
  if (error || !data) return errorResult("challenge_not_found");
  const challenge = data as unknown as ChallengeRow;

  if (challenge.consumed_at !== null && options?.deferConsumedCheck !== true) {
    return errorResult("challenge_consumed");
  }
  if (Number.isNaN(Date.parse(challenge.expires_at)) || new Date(challenge.expires_at).getTime() <= Date.now()) {
    return errorResult("challenge_expired");
  }
  if (
    challenge.campaign_id !== input.campaignId ||
    challenge.action !== CAMPAIGN_CLAIM_ACTION ||
    challenge.version !== CAMPAIGN_CLAIM_VERSION
  ) {
    return errorResult("campaign_mismatch");
  }

  const submittedWallet = normalizeAddress(input.address);
  const derivedWallet = deriveAddressFromPublicKey(input.publicKey);
  if (
    !submittedWallet ||
    !derivedWallet ||
    submittedWallet !== derivedWallet ||
    submittedWallet !== challenge.participant_wallet
  ) {
    return errorResult("wallet_mismatch");
  }

  const valid = verifyNimiqMiniAppSignature(challenge.message, input.publicKey, input.signature);
  if (!valid) return errorResult("invalid_signature");

  return { kind: "ok", participantWallet: challenge.participant_wallet };
}
