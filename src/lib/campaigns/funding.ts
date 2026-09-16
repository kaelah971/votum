import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import { getRewardSettlementVault } from "@/lib/rewards/vault-service";
import type {
  FundingConfirmationResult,
  FundingContextLoadResult,
} from "@/lib/rewards/funding-confirmation";
import {
  createRewardSettlementService,
  type SettlementBindingResult,
  type SettlementFundingResult,
} from "@/lib/rewards/settlement";
import {
  loadRewardSettlementContext as loadSettlementRoot,
} from "@/lib/rewards/settlement-root";
import { resolveCampaignRewardSettlement } from "@/lib/campaigns/settlement";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

type CampaignFundingError = { kind: "error"; reasonCode: string };

function fundingError(reasonCode: string): CampaignFundingError {
  return { kind: "error", reasonCode };
}

interface OwnedCampaignSettlement {
  settlementId: string;
  ownerWallet: string;
}

/**
 * Resolve the Campaign branch and enforce creator ownership for the given
 * funder wallet. Returns the settlement identity on success. All money
 * fields are loaded downstream from authoritative rows; nothing financial
 * originates from the caller beyond identity.
 */
async function resolveOwnedSettlement(
  admin: AdminClient,
  campaignId: string,
  funderWallet: string,
): Promise<OwnedCampaignSettlement | CampaignFundingError> {
  const funder = normalizeAddress(funderWallet);
  if (!funder) return fundingError("forbidden");

  let resolution: Awaited<ReturnType<typeof resolveCampaignRewardSettlement>>;
  try {
    resolution = await resolveCampaignRewardSettlement(admin, campaignId);
  } catch {
    return fundingError("service_unavailable");
  }
  if (resolution.kind === "not_found") return fundingError("campaign_not_found");
  if (resolution.kind === "error") return fundingError("service_unavailable");
  if (funder !== resolution.ownerWallet) return fundingError("forbidden");

  return { settlementId: resolution.settlementId, ownerWallet: resolution.ownerWallet };
}

/**
 * Enforce V2C.3 creator funding policy from the authoritative root:
 * funding_mode must be 'creator' and the designated funding wallet must be
 * the owner. The browser never selects the mode, the funder, or the refund
 * destination.
 */
async function enforceCreatorFundingPolicy(
  admin: AdminClient,
  settlementId: string,
  ownerWallet: string,
): Promise<CampaignFundingError | null> {
  let root: Awaited<ReturnType<typeof loadSettlementRoot>>;
  try {
    root = await loadSettlementRoot(admin, settlementId);
  } catch {
    return fundingError("service_unavailable");
  }
  if (root.kind === "not_found") return fundingError("campaign_not_found");
  if (root.kind === "error") return fundingError("service_unavailable");
  if (
    root.root.fundingMode !== "creator" ||
    root.root.fundingWallet !== ownerWallet ||
    root.root.ownerWallet !== ownerWallet
  ) {
    return fundingError("forbidden");
  }
  return null;
}

async function requireVaultReady(
  settlementId: string,
): Promise<CampaignFundingError | null> {
  let vault: Awaited<ReturnType<typeof getRewardSettlementVault>>;
  try {
    vault = await getRewardSettlementVault(settlementId);
  } catch {
    return fundingError("service_unavailable");
  }
  if (!vault) return fundingError("vault_unavailable");
  return null;
}

/**
 * Begin a Campaign funding intent. Derives settlement, funder, vault,
 * amount, reference, and network server-side, then delegates to the
 * existing settlement funding engine with the settlement ID.
 */
export async function beginCampaignFunding(
  admin: AdminClient,
  campaignId: string,
  funderWallet: string,
): Promise<SettlementFundingResult> {
  const owned = await resolveOwnedSettlement(admin, campaignId, funderWallet);
  if ("reasonCode" in owned) return owned;
  const policy = await enforceCreatorFundingPolicy(admin, owned.settlementId, owned.ownerWallet);
  if (policy) return policy;
  const vault = await requireVaultReady(owned.settlementId);
  if (vault) return vault;
  return createRewardSettlementService(admin).beginFunding(
    owned.settlementId,
    normalizeAddress(funderWallet) as string,
  );
}

/**
 * Bind a client-observed transaction hash to a Campaign funding intent.
 * The hash is a callback, never proof; confirmation stays server-observed.
 */
export async function bindCampaignFunding(
  admin: AdminClient,
  campaignId: string,
  intentId: string,
  funderWallet: string,
  transactionHash: string,
): Promise<SettlementBindingResult> {
  const owned = await resolveOwnedSettlement(admin, campaignId, funderWallet);
  if ("reasonCode" in owned) return owned;
  return createRewardSettlementService(admin).bindFunding(
    owned.settlementId,
    intentId,
    normalizeAddress(funderWallet) as string,
    transactionHash,
  );
}

/**
 * Confirm a Campaign funding intent after server-side observation and
 * finality. Delegates to the existing settlement confirmation path.
 */
export async function confirmCampaignFunding(
  admin: AdminClient,
  campaignId: string,
  intentId: string,
  funderWallet: string,
): Promise<FundingConfirmationResult | Exclude<FundingContextLoadResult, { kind: "ok" }>> {
  const owned = await resolveOwnedSettlement(admin, campaignId, funderWallet);
  if ("reasonCode" in owned) {
    if (owned.reasonCode === "campaign_not_found") {
      return { kind: "not_found", reasonCode: "campaign_not_found" };
    }
    if (owned.reasonCode === "forbidden") {
      return { kind: "forbidden" };
    }
    return { kind: "error", reasonCode: "service_unavailable" };
  }
  return createRewardSettlementService(admin).confirmFunding(
    owned.settlementId,
    intentId,
    normalizeAddress(funderWallet) as string,
  );
}
