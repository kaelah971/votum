import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { formatNimAmount } from "@/lib/nimiq/units";
import { resolveCampaignRewardSettlement } from "@/lib/campaigns/settlement";
import { loadRewardSettlementContext } from "@/lib/rewards/settlement-root";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type PublicCampaignClaimState =
  | "needs_funding"
  | "starts_soon"
  | "open"
  | "full"
  | "ended"
  | "closed"
  | "unpublished";

/** Browser-safe public projection. No wallet, challenge, receipt, vault, lease, signing, or refund field. */
export interface PublicCampaignGiveaway {
  campaignId: string;
  campaignType: "public_giveaway";
  visibility: "public" | "unlisted";
  title: string;
  description: string | null;
  startsAt: string | null;
  endsAt: string | null;
  claimState: PublicCampaignClaimState;
  published: boolean;
  fundingReady: boolean;
  rewardPerParticipantNim: string;
  maxRewardedParticipants: number;
  remainingRewards: number;
  reservedCount: number;
  paidCount: number;
}

export type OwnClaimStatus = "reserved" | "payout_pending" | "paid" | "retryable";

export type OwnCampaignClaim =
  | { claimed: false }
  | {
      claimed: true;
      status: OwnClaimStatus;
      receiptId: string;
      paidAt: string | null;
      transactionHash: string | null;
    };

export interface ClaimStateInput {
  campaignStatus: string;
  settlementStatus: string;
  startsAt: string | null;
  endsAt: string | null;
  remainingRewards: number;
  fundingReady: boolean;
  now: number;
}

const REWARD_READY_STATES: readonly string[] = ["funded", "rewarding", "exhausted"];
const FINANCIALLY_CLOSED_STATES: readonly string[] = ["closed", "refunding", "refunded", "cancelled"];

function parseTime(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Pure derived claim-state machine. Publication and funding are independent
 * inputs; no stored `claimable` flag exists anywhere. Exported for the
 * share-link page and the later participant slice.
 */
export function deriveClaimState(input: ClaimStateInput): PublicCampaignClaimState {
  if (input.campaignStatus === "draft") return "unpublished";
  if (input.campaignStatus === "cancelled") return "closed";
  if (input.campaignStatus === "closed") return "closed";
  if (input.campaignStatus === "expired") return "ended";
  if (FINANCIALLY_CLOSED_STATES.includes(input.settlementStatus)) return "closed";
  if (!input.fundingReady) return "needs_funding";
  const startsAt = parseTime(input.startsAt);
  if (startsAt !== null && input.now < startsAt) return "starts_soon";
  const endsAt = parseTime(input.endsAt);
  if (endsAt !== null && input.now >= endsAt) return "ended";
  if (input.remainingRewards <= 0) return "full";
  if (FINANCIALLY_CLOSED_STATES.includes(input.settlementStatus)) return "closed";
  return "open";
}

interface SettlementEconomics {
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardedParticipantCount: number;
  settlementStatus: string;
}

async function loadEconomics(
  admin: AdminClient,
  settlementId: string,
): Promise<SettlementEconomics | null> {
  // The settlement-root loader is the economics authority here: unlike the
  // payout-oriented settlement context, it carries the capacity counts the
  // remaining-rewards derivation requires. Vault presence is a funding-path
  // precondition, not a public-read field, so no vault read is needed.
  const root = await loadRewardSettlementContext(admin, settlementId);
  if (root.kind !== "ok") return null;
  return {
    rewardPerParticipantLuna: root.root.rewardPerParticipantLuna,
    maxRewardedParticipants: root.root.maxRewardedParticipants,
    rewardedParticipantCount: root.root.rewardedParticipantCount,
    settlementStatus: root.root.status,
  };
}

async function countReceipts(
  admin: AdminClient,
  settlementId: string,
  status: string,
): Promise<number | null> {
  const { count, error } = await admin
    .from("reward_receipts")
    .select("id", { count: "exact", head: true })
    .eq("settlement_id", settlementId)
    .eq("status", status);
  if (error || count === null) return null;
  return count;
}

/**
 * Server-only public projector. Returns null for missing, non-giveaway,
 * private, draft, or cancelled Campaigns, and for unresolvable settlements.
 * Every value is derived from authoritative rows on each call.
 */
export async function getPublicCampaignGiveaway(
  admin: AdminClient,
  campaignId: string,
): Promise<PublicCampaignGiveaway | null> {
  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id, campaign_type, visibility, title, description, status, starts_at, ends_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError || !campaign) return null;
  if (campaign.campaign_type !== "public_giveaway") return null;
  if (campaign.visibility !== "public" && campaign.visibility !== "unlisted") return null;
  if (campaign.status === "draft" || campaign.status === "cancelled") return null;

  const binding = await resolveCampaignRewardSettlement(admin, campaign.id);
  if (binding.kind !== "ok") return null;

  const economics = await loadEconomics(admin, binding.settlementId);
  if (!economics) return null;

  const reserved = await countReceipts(admin, binding.settlementId, "reserved");
  const paid = await countReceipts(admin, binding.settlementId, "paid");
  if (reserved === null || paid === null) return null;

  const remaining = Math.max(0, economics.maxRewardedParticipants - economics.rewardedParticipantCount);
  const fundingReady = REWARD_READY_STATES.includes(economics.settlementStatus);

  return {
    campaignId: campaign.id,
    campaignType: "public_giveaway",
    visibility: campaign.visibility,
    title: campaign.title,
    description: campaign.description,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    claimState: deriveClaimState({
      campaignStatus: campaign.status,
      settlementStatus: economics.settlementStatus,
      startsAt: campaign.starts_at,
      endsAt: campaign.ends_at,
      remainingRewards: remaining,
      fundingReady,
      now: Date.now(),
    }),
    published: campaign.status === "published",
    fundingReady,
    rewardPerParticipantNim: formatNimAmount(economics.rewardPerParticipantLuna),
    maxRewardedParticipants: economics.maxRewardedParticipants,
    remainingRewards: remaining,
    reservedCount: reserved,
    paidCount: paid,
  };
}

const OWN_STATUSES: readonly string[] = ["reserved", "payout_pending", "paid", "retryable"];

function isOwnStatus(value: unknown): value is OwnClaimStatus {
  return typeof value === "string" && (OWN_STATUSES as readonly string[]).includes(value);
}

/**
 * Session-scoped own-entitlement read. Returns null for unresolvable
 * Campaigns (the route maps this to 404) and `{ claimed: false }` whenever
 * the session wallet holds no receipt in the four participant-facing
 * states — identical whether the Campaign is empty or another wallet
 * claimed. Creates nothing and consumes no challenge.
 */
export async function getOwnCampaignClaim(
  admin: AdminClient,
  campaignId: string,
  sessionWallet: string,
): Promise<OwnCampaignClaim | null> {
  const session = normalizeAddress(sessionWallet);
  if (!session) return { claimed: false };

  const binding = await resolveCampaignRewardSettlement(admin, campaignId);
  if (binding.kind !== "ok") return null;

  const { data: receipts, error } = await admin
    .from("reward_receipts")
    .select("id, status, paid_at, participant_wallet")
    .eq("settlement_id", binding.settlementId)
    .limit(1001);
  if (error || !receipts) return { claimed: false };

  const mine = receipts.find((row) => normalizeAddress(row.participant_wallet) === session);
  if (!mine || !isOwnStatus(mine.status)) return { claimed: false };

  const { data: attempt } = await admin
    .from("reward_payout_attempts")
    .select("transaction_hash")
    .eq("receipt_id", mine.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    claimed: true,
    status: mine.status,
    receiptId: mine.id,
    paidAt: mine.paid_at,
    transactionHash: typeof attempt?.transaction_hash === "string" ? attempt.transaction_hash : null,
  };
}
