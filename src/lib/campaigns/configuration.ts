import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  MAX_REWARDED_PARTICIPANTS,
  validateRewardConfigInput,
} from "@/lib/rewards/config";
import { LUNA_PER_NIM, PG_BIGINT_MAX } from "@/lib/nimiq/units";
import { addressesEqual, normalizeAddress } from "@/lib/nimiq/server-crypto";
import type {
  CampaignConfiguration,
  CampaignConfigurationReadModel,
  CampaignVisibility,
  ParticipationCampaignStatus,
  ParticipationCampaignType,
} from "@/lib/campaigns/types";
import type { Database } from "@/types/database";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;
type CampaignRow = Database["public"]["Tables"]["participation_campaigns"]["Row"];
type SettlementRow = Database["public"]["Tables"]["reward_settlements"]["Row"];
type SettlementConfigurationRow = Pick<
  SettlementRow,
  | "id"
  | "owner_wallet"
  | "funding_mode"
  | "funding_wallet"
  | "refund_recipient_wallet"
  | "reward_per_participant_luna"
  | "max_rewarded_participants"
  | "reward_principal_luna"
  | "fee_reserve_luna"
  | "total_budget_luna"
  | "funded_amount_luna"
  | "status"
  | "first_reservation_at"
>;

export interface CampaignConfigurationInput {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  visibility?: unknown;
  startsAt?: unknown;
  endsAt?: unknown;
  rewardPerParticipant?: unknown;
  maxRewardedParticipants?: unknown;
  fundingMode?: unknown;
  fundingWallet?: unknown;
  [key: string]: unknown;
}

export interface ValidatedCampaignConfiguration {
  ownerWallet: string;
  campaignType: ParticipationCampaignType;
  title: string;
  description: string | null;
  visibility: CampaignVisibility;
  startsAt: string | null;
  endsAt: string | null;
  fundingMode: "creator" | "community";
  fundingWallet: string;
  refundRecipientWallet: string;
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
}

export interface CampaignFieldError {
  field: string;
  message: string;
}

export type CampaignConfigurationErrorCode =
  | "invalid_request"
  | "forbidden"
  | "not_found"
  | "immutable"
  | "not_publishable"
  | "service_unavailable"
  | "persistence_failed"
  | "invariant_failed";

export class CampaignConfigurationError extends Error {
  readonly code: CampaignConfigurationErrorCode;
  readonly status: number;
  readonly fieldErrors: CampaignFieldError[];

  constructor(
    code: CampaignConfigurationErrorCode,
    status: number,
    message: string,
    fieldErrors: CampaignFieldError[] = [],
  ) {
    super(message);
    this.name = "CampaignConfigurationError";
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

const CAMPAIGN_TYPES: readonly ParticipationCampaignType[] = [
  "public_giveaway",
  "secret_drop",
  "private_drop",
  "event_drop",
  "community_reward",
];

const VISIBILITIES: readonly CampaignVisibility[] = ["public", "unlisted", "private"];

const AUTHORITY_FIELDS = [
  "owner",
  "ownerWallet",
  "creatorWallet",
  "owner_wallet",
  "creator_wallet",
  "wallet",
  "campaignId",
  "settlementId",
  "rootId",
  "vaultId",
  "vaultAddress",
  "vaultAddressHex",
  "vaultKeyRef",
  "campaign_id",
  "settlement_id",
  "root_id",
  "vault_id",
  "vault_address",
  "vault_address_hex",
  "vault_key_ref",
  "refundRecipientWallet",
  "refund_recipient_wallet",
  "rewardPrincipalLuna",
  "reward_principal_luna",
  "principalLuna",
  "principal_luna",
  "feeReserveLuna",
  "fee_reserve_luna",
  "feeReserve",
  "totalBudgetLuna",
  "total_budget_luna",
  "total",
  "fundedAmountLuna",
  "funded_amount_luna",
  "rewardedParticipantCount",
  "rewarded_participant_count",
  "paidAmountLuna",
  "paid_amount_luna",
  "refundableAmountLuna",
  "refundable_amount_luna",
  "financialStatus",
  "financial_status",
  "status",
  "claimable",
  "funded",
  "configurationVersion",
  "publishedConfigurationVersion",
  "configuration_version",
  "published_configuration_version",
] as const;

const EDITABLE_FIELDS = [
  "type",
  "title",
  "description",
  "visibility",
  "startsAt",
  "endsAt",
  "rewardPerParticipant",
  "maxRewardedParticipants",
  "fundingMode",
  "fundingWallet",
] as const;

const ALLOWED_INPUT_FIELDS = new Set<string>([
  ...EDITABLE_FIELDS,
  ...AUTHORITY_FIELDS,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(fieldName: string, message: string): CampaignFieldError {
  return { field: fieldName, message };
}

function invalid(errors: CampaignFieldError[]): {
  ok: false;
  errors: CampaignFieldError[];
} {
  return { ok: false, errors };
}

function valid(value: ValidatedCampaignConfiguration): {
  ok: true;
  value: ValidatedCampaignConfiguration;
} {
  return { ok: true, value };
}

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function valueOrExisting(
  input: Record<string, unknown>,
  key: string,
  existing: Record<string, unknown> | undefined,
): unknown {
  return hasOwn(input, key) ? input[key] : existing?.[key];
}

function parseDate(value: unknown, fieldName: string, errors: CampaignFieldError[]): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    errors.push(field(fieldName, "Date must be an ISO timestamp or null."));
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    errors.push(field(fieldName, "Date must be a valid ISO timestamp."));
    return null;
  }
  return date.toISOString();
}

function parseMaxParticipants(value: unknown): number {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : Number.NaN;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return Number.NaN;
  try {
    const parsed = BigInt(value.trim());
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.NaN;
    return Number(parsed);
  } catch {
    return Number.NaN;
  }
}

function decimalNimFromLuna(value: bigint): string {
  const whole = value / LUNA_PER_NIM;
  const fraction = (value % LUNA_PER_NIM).toString().padStart(5, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseOwner(ownerWallet: string): string {
  const canonical = normalizeAddress(ownerWallet);
  if (!canonical) {
    throw new CampaignConfigurationError(
      "invalid_request",
      400,
      "The verified wallet address is invalid.",
    );
  }
  return canonical;
}

function checkAuthorityFields(input: Record<string, unknown>, errors: CampaignFieldError[]): void {
  for (const key of AUTHORITY_FIELDS) {
    if (hasOwn(input, key)) {
      errors.push(field(key, "This value is derived by the server and cannot be supplied."));
    }
  }
}

/**
 * Validate product fields and derive all NIM terms before any database write.
 * Existing values are supplied only for PATCH merging and are never accepted
 * from the request as authoritative financial state.
 */
export function parseCampaignConfigurationInput(
  rawInput: unknown,
  ownerWallet: string,
  existing?: CampaignConfigurationInput,
): { ok: true; value: ValidatedCampaignConfiguration } | { ok: false; errors: CampaignFieldError[] } {
  if (!isRecord(rawInput)) {
    return invalid([field("body", "Request body must be an object.")]);
  }

  const errors: CampaignFieldError[] = [];
  checkAuthorityFields(rawInput, errors);
  for (const key of Object.keys(rawInput)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      errors.push(field(key, "This Campaign field is not supported in this slice."));
    }
  }
  const owner = normalizeAddress(ownerWallet);
  if (!owner) errors.push(field("session", "The verified wallet address is invalid."));

  const campaignType = valueOrExisting(rawInput, "type", existing);
  if (!CAMPAIGN_TYPES.includes(campaignType as ParticipationCampaignType)) {
    errors.push(field("type", "Choose an approved Campaign type."));
  }

  const rawTitle = valueOrExisting(rawInput, "title", existing);
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  if (typeof rawTitle !== "string" || title.length < 1 || title.length > 160) {
    errors.push(field("title", "Title must be between 1 and 160 characters."));
  }

  const rawDescription = valueOrExisting(rawInput, "description", existing);
  let description: string | null = null;
  if (rawDescription === null || rawDescription === undefined || rawDescription === "") {
    description = null;
  } else if (typeof rawDescription !== "string") {
    errors.push(field("description", "Description must be a string or null."));
  } else if (rawDescription.length > 4000) {
    errors.push(field("description", "Description must be at most 4000 characters."));
  } else {
    description = rawDescription.trim() || null;
  }

  const visibility = valueOrExisting(rawInput, "visibility", existing);
  if (!VISIBILITIES.includes(visibility as CampaignVisibility)) {
    errors.push(field("visibility", "Choose public, unlisted, or private visibility."));
  }

  const startsAt = parseDate(valueOrExisting(rawInput, "startsAt", existing), "startsAt", errors);
  const endsAt = parseDate(valueOrExisting(rawInput, "endsAt", existing), "endsAt", errors);
  if (startsAt && endsAt && new Date(endsAt) <= new Date(startsAt)) {
    errors.push(field("endsAt", "End time must be after start time."));
  }

  const rewardPerParticipant = valueOrExisting(rawInput, "rewardPerParticipant", existing);
  const maxRewardedParticipants = parseMaxParticipants(
    valueOrExisting(rawInput, "maxRewardedParticipants", existing),
  );
  const rewardValidation = validateRewardConfigInput({
    rewardPerParticipant: typeof rewardPerParticipant === "string" ? rewardPerParticipant : "",
    maxRewardedParticipants,
  });
  if (!rewardValidation.ok || !rewardValidation.value) {
    for (const message of rewardValidation.errors) {
      errors.push(field(
        message.startsWith("maxRewardedParticipants") ? "maxRewardedParticipants" : "rewardPerParticipant",
        message,
      ));
    }
  }

  const fundingMode = valueOrExisting(rawInput, "fundingMode", existing);
  const normalizedFundingMode = fundingMode === undefined ? "creator" : fundingMode;
  if (normalizedFundingMode !== "creator" && normalizedFundingMode !== "community") {
    errors.push(field("fundingMode", "Funding mode must be creator or community."));
  }

  const rawFundingWallet = valueOrExisting(rawInput, "fundingWallet", existing);
  let fundingWallet = owner ?? "";
  if (normalizedFundingMode === "community") {
    if (typeof rawFundingWallet !== "string") {
      errors.push(field("fundingWallet", "A valid designated funding wallet is required."));
    } else {
      fundingWallet = normalizeAddress(rawFundingWallet) ?? "";
      if (!fundingWallet) {
        errors.push(field("fundingWallet", "A valid designated funding wallet is required."));
      }
    }
  } else if (rawFundingWallet !== undefined && rawFundingWallet !== null && rawFundingWallet !== "") {
    if (typeof rawFundingWallet !== "string") {
      errors.push(field("fundingWallet", "Creator funding must use the verified creator wallet."));
    } else {
      const requestedWallet = normalizeAddress(rawFundingWallet);
      if (!requestedWallet || !owner || !addressesEqual(requestedWallet, owner)) {
        errors.push(field("fundingWallet", "Creator funding must use the verified creator wallet."));
      }
    }
  }

  if (errors.length > 0 || !owner || !rewardValidation.ok || !rewardValidation.value) {
    return invalid(errors);
  }

  return valid({
    ownerWallet: owner,
    campaignType: campaignType as ParticipationCampaignType,
    title,
    description,
    visibility: visibility as CampaignVisibility,
    startsAt,
    endsAt,
    fundingMode: normalizedFundingMode as "creator" | "community",
    fundingWallet,
    refundRecipientWallet: owner,
    rewardPerParticipantLuna: rewardValidation.value.rewardPerParticipantLuna,
    maxRewardedParticipants: rewardValidation.value.maxRewardedParticipants,
    rewardPrincipalLuna: rewardValidation.value.rewardPrincipalLuna,
    feeReserveLuna: rewardValidation.value.feeReserveLuna,
    totalBudgetLuna: rewardValidation.value.totalBudgetLuna,
  });
}

function adminOrThrow(): AdminClient {
  const admin = createAdminClient();
  if (!admin) {
    throw new CampaignConfigurationError(
      "service_unavailable",
      503,
      "Campaign configuration is temporarily unavailable.",
    );
  }
  return admin;
}

type JsonRpcResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

type JsonRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<JsonRpcResult>;
};

function callJsonRpc(
  admin: AdminClient,
  name: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResult> {
  return (admin as unknown as JsonRpcClient).rpc(name, args);
}

function mapRpcError(error: { code?: string; message?: string } | null): CampaignConfigurationError {
  if (/publishable/i.test(error?.message ?? "")) {
    return new CampaignConfigurationError("not_publishable", 409, "This Campaign type is not publishable yet.");
  }
  if (error?.code === "42501") {
    return new CampaignConfigurationError("forbidden", 403, "This Campaign operation is not authorized.");
  }
  if (error?.code === "restrict_violation" || error?.code === "23001" || error?.code === "23P01") {
    return new CampaignConfigurationError("immutable", 409, "This Campaign configuration is no longer editable.");
  }
  if (error?.code === "no_data_found" || error?.code === "P0002") {
    return new CampaignConfigurationError("not_found", 404, "Campaign not found.");
  }
  if (error?.code === "23514" || error?.code === "22003" || error?.code === "22P02") {
    return new CampaignConfigurationError("invalid_request", 400, "Campaign configuration is invalid.");
  }
  return new CampaignConfigurationError("persistence_failed", 500, "Could not persist Campaign configuration.");
}

function databaseBigInt(value: unknown, fieldName: string): bigint {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  } catch {
    /* fall through to the invariant error */
  }
  throw new CampaignConfigurationError("invariant_failed", 500, `Stored ${fieldName} is invalid.`);
}

function databaseInteger(value: unknown, fieldName: string): number {
  const parsed = databaseBigInt(value, fieldName);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CampaignConfigurationError("invariant_failed", 500, `Stored ${fieldName} is too large.`);
  }
  return Number(parsed);
}

function existingInput(campaign: CampaignRow, settlement: SettlementConfigurationRow): CampaignConfigurationInput {
  return {
    type: campaign.campaign_type,
    title: campaign.title,
    description: campaign.description,
    visibility: campaign.visibility,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    rewardPerParticipant: decimalNimFromLuna(
      databaseBigInt(settlement.reward_per_participant_luna, "reward_per_participant_luna"),
    ),
    maxRewardedParticipants: databaseInteger(
      settlement.max_rewarded_participants,
      "max_rewarded_participants",
    ),
    fundingMode: settlement.funding_mode,
    fundingWallet: settlement.funding_wallet,
  };
}

function safeCampaign(campaign: CampaignRow, settlement: SettlementConfigurationRow): CampaignConfiguration {
  const rewardPerParticipantLuna = databaseBigInt(
    settlement.reward_per_participant_luna,
    "reward_per_participant_luna",
  );
  const rewardPrincipalLuna = databaseBigInt(
    settlement.reward_principal_luna,
    "reward_principal_luna",
  );
  const feeReserveLuna = databaseBigInt(settlement.fee_reserve_luna, "fee_reserve_luna");
  const totalBudgetLuna = databaseBigInt(settlement.total_budget_luna, "total_budget_luna");

  return {
    campaignId: campaign.id,
    settlementId: campaign.settlement_id,
    ownerWallet: campaign.owner_wallet,
    campaignType: campaign.campaign_type as ParticipationCampaignType,
    visibility: campaign.visibility as CampaignVisibility,
    title: campaign.title,
    description: campaign.description,
    status: campaign.status as ParticipationCampaignStatus,
    configurationVersion: campaign.configuration_version,
    publishedConfigurationVersion: campaign.published_configuration_version,
    startsAt: campaign.starts_at,
    endsAt: campaign.ends_at,
    closeReason: campaign.close_reason,
    configurationLockedAt: campaign.configuration_locked_at,
    publishedAt: campaign.published_at,
    closedAt: campaign.closed_at,
    createdAt: campaign.created_at,
    updatedAt: campaign.updated_at,
    fundingMode: settlement.funding_mode as "creator" | "community",
    fundingWallet: settlement.funding_wallet,
    reward: {
      rewardPerParticipantLuna: rewardPerParticipantLuna.toString(),
      rewardPerParticipantNim: decimalNimFromLuna(rewardPerParticipantLuna),
      maxRewardedParticipants: databaseInteger(
        settlement.max_rewarded_participants,
        "max_rewarded_participants",
      ),
      rewardPrincipalLuna: rewardPrincipalLuna.toString(),
      rewardPrincipalNim: decimalNimFromLuna(rewardPrincipalLuna),
      feeReserveLuna: feeReserveLuna.toString(),
      feeReserveNim: decimalNimFromLuna(feeReserveLuna),
      totalBudgetLuna: totalBudgetLuna.toString(),
      totalBudgetNim: decimalNimFromLuna(totalBudgetLuna),
    },
  };
}

async function loadOwnedCampaign(
  ownerWallet: string,
  campaignId: string,
  admin: AdminClient,
): Promise<{ campaign: CampaignRow; settlement: SettlementConfigurationRow; safe: CampaignConfiguration }> {
  const { data: campaign, error: campaignError } = await admin
    .from("participation_campaigns")
    .select("id, settlement_id, owner_wallet, campaign_type, visibility, title, description, status, configuration_version, published_configuration_version, starts_at, ends_at, close_reason, configuration_locked_at, published_at, closed_at, created_at, updated_at")
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) {
    if (campaignError.code === "22P02") {
      throw new CampaignConfigurationError("not_found", 404, "Campaign not found.");
    }
    throw new CampaignConfigurationError("persistence_failed", 500, "Could not load the Campaign.");
  }
  if (!campaign) {
    throw new CampaignConfigurationError("not_found", 404, "Campaign not found.");
  }

  const sessionOwner = normalizeAddress(ownerWallet);
  if (!sessionOwner || !addressesEqual(campaign.owner_wallet, sessionOwner)) {
    throw new CampaignConfigurationError("forbidden", 403, "Only the Campaign owner may access it.");
  }

  const { data: settlement, error: settlementError } = await admin
    .from("reward_settlements")
    .select("id, owner_wallet, funding_mode, funding_wallet, refund_recipient_wallet, reward_per_participant_luna, max_rewarded_participants, reward_principal_luna, fee_reserve_luna, total_budget_luna, funded_amount_luna, status, first_reservation_at")
    .eq("id", campaign.settlement_id)
    .maybeSingle();
  if (settlementError || !settlement) {
    throw new CampaignConfigurationError("invariant_failed", 500, "Campaign settlement is unavailable.");
  }
  if (!addressesEqual(campaign.owner_wallet, settlement.owner_wallet)) {
    throw new CampaignConfigurationError("invariant_failed", 500, "Campaign ownership invariant failed.");
  }

  const { data: binding, error: bindingError } = await admin
    .from("settlement_source_bindings")
    .select("settlement_id, source_type, reward_campaign_id, participation_campaign_id")
    .eq("settlement_id", campaign.settlement_id)
    .maybeSingle();
  if (
    bindingError ||
    !binding ||
    binding.source_type !== "participation_campaign" ||
    binding.participation_campaign_id !== campaign.id ||
    binding.reward_campaign_id !== null
  ) {
    throw new CampaignConfigurationError("invariant_failed", 500, "Campaign source binding invariant failed.");
  }

  return { campaign, settlement, safe: safeCampaign(campaign, settlement) };
}

function rpcDataId(data: unknown, key: "campaign_id" | "settlement_id"): string {
  if (isRecord(data) && typeof data[key] === "string" && data[key].length > 0) return data[key];
  throw new CampaignConfigurationError("persistence_failed", 500, "Campaign persistence returned no identity.");
}

function rpcArguments(value: ValidatedCampaignConfiguration) {
  return {
    _owner_wallet: value.ownerWallet,
    _campaign_type: value.campaignType,
    _visibility: value.visibility,
    _title: value.title,
    _description: value.description,
    _starts_at: value.startsAt,
    _ends_at: value.endsAt,
    _funding_mode: value.fundingMode,
    _funding_wallet: value.fundingWallet,
    _reward_per_participant_luna: value.rewardPerParticipantLuna.toString(),
    _max_rewarded_participants: value.maxRewardedParticipants,
    _fee_reserve_luna: value.feeReserveLuna.toString(),
  } satisfies Record<string, unknown>;
}

export async function createParticipationCampaign(
  ownerWallet: string,
  rawInput: unknown,
): Promise<{ campaign: CampaignConfiguration }> {
  const owner = parseOwner(ownerWallet);
  const validation = parseCampaignConfigurationInput(rawInput, owner);
  if (!validation.ok) {
    throw new CampaignConfigurationError(
      "invalid_request",
      400,
      "Campaign configuration is invalid.",
      validation.errors,
    );
  }

  const admin = adminOrThrow();
  const { data, error } = await callJsonRpc(
    admin,
    "create_participation_campaign_atomic",
    rpcArguments(validation.value),
  );
  if (error) throw mapRpcError(error);
  const campaignId = rpcDataId(data, "campaign_id");
  const loaded = await loadOwnedCampaign(owner, campaignId, admin);
  return { campaign: loaded.safe };
}

export async function updateParticipationCampaignDraft(
  ownerWallet: string,
  campaignId: string,
  rawInput: unknown,
): Promise<{ campaign: CampaignConfiguration }> {
  const owner = parseOwner(ownerWallet);
  if (!isRecord(rawInput)) {
    throw new CampaignConfigurationError("invalid_request", 400, "Request body must be an object.");
  }
  if (!EDITABLE_FIELDS.some((key) => hasOwn(rawInput, key))) {
    throw new CampaignConfigurationError("invalid_request", 400, "Provide at least one editable Campaign field.");
  }

  const admin = adminOrThrow();
  const loaded = await loadOwnedCampaign(owner, campaignId, admin);
  if (loaded.campaign.status !== "draft" || loaded.campaign.configuration_locked_at !== null) {
    throw new CampaignConfigurationError("immutable", 409, "Published Campaign configuration cannot be changed.");
  }

  const validation = parseCampaignConfigurationInput(
    rawInput,
    owner,
    existingInput(loaded.campaign, loaded.settlement),
  );
  if (!validation.ok) {
    throw new CampaignConfigurationError(
      "invalid_request",
      400,
      "Campaign configuration is invalid.",
      validation.errors,
    );
  }

  const nextVersion = loaded.campaign.configuration_version + 1;
  if (!Number.isSafeInteger(nextVersion)) {
    throw new CampaignConfigurationError("invariant_failed", 500, "Campaign configuration version is invalid.");
  }
  const { error } = await callJsonRpc(
    admin,
    "update_participation_campaign_draft_atomic",
    {
      _campaign_id: campaignId,
      _title: validation.value.title,
      _description: validation.value.description,
      _campaign_type: validation.value.campaignType,
      _visibility: validation.value.visibility,
      _starts_at: validation.value.startsAt,
      _ends_at: validation.value.endsAt,
      _configuration_version: nextVersion,
      _funding_mode: validation.value.fundingMode,
      _funding_wallet: validation.value.fundingWallet,
      _reward_per_participant_luna: validation.value.rewardPerParticipantLuna.toString(),
      _max_rewarded_participants: validation.value.maxRewardedParticipants,
      _fee_reserve_luna: validation.value.feeReserveLuna.toString(),
    },
  );
  if (error) throw mapRpcError(error);
  const refreshed = await loadOwnedCampaign(owner, campaignId, admin);
  return { campaign: refreshed.safe };
}

export async function publishParticipationCampaign(
  ownerWallet: string,
  campaignId: string,
): Promise<{ campaign: CampaignConfiguration }> {
  const owner = parseOwner(ownerWallet);
  const admin = adminOrThrow();
  const loaded = await loadOwnedCampaign(owner, campaignId, admin);
  if (loaded.campaign.status !== "draft" || loaded.campaign.configuration_locked_at !== null) {
    throw new CampaignConfigurationError("immutable", 409, "This Campaign is already frozen.");
  }
  if (loaded.campaign.campaign_type !== "public_giveaway") {
    throw new CampaignConfigurationError("not_publishable", 409, "This Campaign type is not publishable yet.");
  }

  const { error } = await callJsonRpc(admin, "publish_participation_campaign_atomic", {
    _campaign_id: campaignId,
    _published_configuration_version: loaded.campaign.configuration_version,
  });
  if (error) throw mapRpcError(error);
  const refreshed = await loadOwnedCampaign(owner, campaignId, admin);
  return { campaign: refreshed.safe };
}

export async function loadCampaignFundingReadiness(
  ownerWallet: string,
  campaignId: string,
): Promise<{
  campaign: CampaignConfiguration;
  fundingReadiness: {
    ready: boolean;
    reason: "ready_for_funding" | "vault_not_ready" | "financially_frozen";
    settlementStatus: string;
    fundedAmountLuna: string;
    requiredAmountLuna: string;
    vaultReady: boolean;
  };
}> {
  const owner = parseOwner(ownerWallet);
  const admin = adminOrThrow();
  const loaded = await loadOwnedCampaign(owner, campaignId, admin);

  const { data: vault, error: vaultError } = await admin
    .from("reward_campaign_vaults")
    .select("settlement_id, campaign_id")
    .eq("settlement_id", loaded.settlement.id)
    .maybeSingle();
  if (vaultError) {
    throw new CampaignConfigurationError("persistence_failed", 500, "Could not read Campaign readiness.");
  }

  const vaultRow = (vault ?? null) as { campaign_id: string | null } | null;
  const vaultReady = vaultRow !== null && vaultRow.campaign_id === null;
  const settlementStatus = loaded.settlement.status;
  const fundedAmountLuna = databaseBigInt(
    loaded.settlement.funded_amount_luna,
    "funded_amount_luna",
  ).toString();
  const requiredAmountLuna = databaseBigInt(
    loaded.settlement.total_budget_luna,
    "total_budget_luna",
  ).toString();

  // Reward-ready is distinct from both publication and the funding funnel:
  // it reports whether settlement funding is present, never claimability.
  const ready = vaultReady &&
    (settlementStatus === "funded" ||
      settlementStatus === "rewarding" ||
      settlementStatus === "exhausted");

  if (loaded.settlement.status !== "configured" || loaded.settlement.first_reservation_at !== null) {
    return {
      campaign: loaded.safe,
      fundingReadiness: {
        ready,
        reason: "financially_frozen",
        settlementStatus,
        fundedAmountLuna,
        requiredAmountLuna,
        vaultReady,
      },
    };
  }

  return {
    campaign: loaded.safe,
    fundingReadiness: vaultReady
      ? {
        ready,
        reason: "ready_for_funding",
        settlementStatus,
        fundedAmountLuna,
        requiredAmountLuna,
        vaultReady,
      }
      : {
        ready,
        reason: "vault_not_ready",
        settlementStatus,
        fundedAmountLuna,
        requiredAmountLuna,
        vaultReady,
      },
  };
}

export function campaignConfigurationErrorDetails(error: unknown): {
  status: number;
  error: string;
  message: string;
  fieldErrors?: CampaignFieldError[];
} {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "persistence_failed";
  const status = isRecord(error) && typeof error.status === "number" ? error.status : undefined;
  const message = isRecord(error) && typeof error.message === "string" ? error.message : undefined;
  const fieldErrors = isRecord(error) && Array.isArray(error.fieldErrors)
    ? error.fieldErrors.filter(
      (item): item is CampaignFieldError => isRecord(item) && typeof item.field === "string" && typeof item.message === "string",
    )
    : undefined;

  switch (code) {
    case "invalid_request":
      return { status: status ?? 400, error: code, message: message ?? "Campaign configuration is invalid.", ...(fieldErrors?.length ? { fieldErrors } : {}) };
    case "forbidden":
      return { status: 403, error: code, message: "Only the Campaign owner may access it." };
    case "not_found":
      return { status: 404, error: code, message: "Campaign not found." };
    case "immutable":
      return { status: 409, error: code, message: message ?? "Campaign configuration is frozen." };
    case "not_publishable":
      return { status: 409, error: code, message: "This Campaign type is not publishable yet." };
    case "service_unavailable":
      return { status: 503, error: code, message: "Campaign configuration is temporarily unavailable." };
    default:
      return { status: 500, error: "configuration_failed", message: "Could not process Campaign configuration." };
  }
}

export function campaignInputHasAuthorityFields(input: unknown): boolean {
  return isRecord(input) && AUTHORITY_FIELDS.some((key) => hasOwn(input, key));
}

export function toCampaignConfigurationReadModel(
  campaign: CampaignConfiguration,
): CampaignConfigurationReadModel {
  const reward = isRecord(campaign.reward) && typeof campaign.reward.rewardPerParticipantNim === "string"
    ? { rewardPerParticipantNim: campaign.reward.rewardPerParticipantNim }
    : null;

  return {
    campaignId: campaign.campaignId,
    campaignType: campaign.campaignType,
    visibility: campaign.visibility,
    title: campaign.title,
    description: campaign.description,
    status: campaign.status,
    configurationVersion: campaign.configurationVersion,
    publishedConfigurationVersion: campaign.publishedConfigurationVersion,
    startsAt: campaign.startsAt,
    endsAt: campaign.endsAt,
    publishedAt: campaign.publishedAt,
    reward,
  };
}

export const CAMPAIGN_CONFIGURATION_LIMITS = {
  maxRewardedParticipants: MAX_REWARDED_PARTICIPANTS,
  maxLuna: PG_BIGINT_MAX,
};
