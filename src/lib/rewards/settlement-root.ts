import "server-only";

import { normalizeAddress } from "@/lib/nimiq/server-crypto";
import {
  isRewardCampaignState,
  type RewardCampaignState,
} from "@/lib/rewards/states";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;
type Row = Record<string, unknown>;

interface QueryResult {
  data: unknown;
  error: unknown;
}

interface UntypedQuery extends PromiseLike<QueryResult> {
  select(columns?: string): UntypedQuery;
  eq(column: string, value: unknown): UntypedQuery;
  maybeSingle(): Promise<QueryResult>;
}

interface UntypedAdminClient {
  from(table: string): UntypedQuery;
}

function query(admin: AdminClient, table: string): UntypedQuery {
  return (admin as unknown as UntypedAdminClient).from(table);
}

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Row
    : null;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter((row): row is Row => asRow(row) !== null)
    : [];
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function integerLuna(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  return null;
}

function safeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function canonicalRootWallet(value: unknown): string | null {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) return null;
  return normalizeAddress(value) === value ? value : null;
}

export type HistoricalWalletClassification =
  | "canonical_hex"
  | "alternate_valid_nimiq"
  | "invalid";

export interface HistoricalWalletIdentity {
  sourceTable: string;
  sourceId: string;
  column: string;
  value: string | null;
  /** Optional uniqueness domain supplied by a caller with a real unique rule. */
  uniquenessScope?: string;
}

export interface WalletAuditEntry {
  sourceTable: string;
  sourceId: string;
  column: string;
  classification: HistoricalWalletClassification;
  canonicalValue: string | null;
}

export interface HistoricalWalletRelationship {
  sourceTable: string;
  sourceId: string;
  relation: string;
  actualValue: string | null;
  expectedValue: string | null;
}

export interface WalletAuditRelationship {
  sourceTable: string;
  sourceId: string;
  relation: string;
  result: "consistent" | "mismatch";
  actualCanonicalValue: string | null;
  expectedCanonicalValue: string | null;
}

export interface WalletAuditCollision {
  uniquenessScope: string;
  canonicalValue: string;
  sourceIds: string[];
}

export interface WalletAuditReport {
  entries: WalletAuditEntry[];
  invalid: WalletAuditEntry[];
  collisions: WalletAuditCollision[];
  relationships: WalletAuditRelationship[];
  relationshipMismatches: WalletAuditRelationship[];
  canProceed: boolean;
}

/**
 * Classify historical wallet values without rewriting their source rows. A
 * uniqueness scope is opt-in because the same wallet is expected to occur in
 * many Polls and financial rows; repeated values alone are not a collision.
 */
function buildCanonicalWalletAudit(
  identities: readonly HistoricalWalletIdentity[],
  relationships: readonly HistoricalWalletRelationship[] = [],
): WalletAuditReport {
  const entries = identities.map((identity): WalletAuditEntry => {
    const canonicalValue = typeof identity.value === "string"
      ? normalizeAddress(identity.value)
      : null;
    const classification = canonicalValue === null
      ? "invalid"
      : identity.value === canonicalValue
        ? "canonical_hex"
        : "alternate_valid_nimiq";
    return {
      sourceTable: identity.sourceTable,
      sourceId: identity.sourceId,
      column: identity.column,
      classification,
      canonicalValue,
    };
  });

  const scoped = new Map<string, Map<string, Set<string>>>();
  for (const [index, identity] of identities.entries()) {
    const canonicalValue = entries[index].canonicalValue;
    if (!identity.uniquenessScope || canonicalValue === null) continue;
    const byCanonical = scoped.get(identity.uniquenessScope) ?? new Map();
    const sourceIds = byCanonical.get(canonicalValue) ?? new Set();
    sourceIds.add(identity.sourceId);
    byCanonical.set(canonicalValue, sourceIds);
    scoped.set(identity.uniquenessScope, byCanonical);
  }

  const collisions: WalletAuditCollision[] = [];
  for (const [uniquenessScope, byCanonical] of scoped) {
    for (const [canonicalValue, sourceIds] of byCanonical) {
      if (sourceIds.size > 1) {
        collisions.push({
          uniquenessScope,
          canonicalValue,
          sourceIds: [...sourceIds].sort(),
        });
      }
    }
  }

  const invalid = entries.filter((entry) => entry.classification === "invalid");
  const relationshipResults = relationships.map((relationship): WalletAuditRelationship => {
    const actualCanonicalValue = relationship.actualValue === null
      ? null
      : normalizeAddress(relationship.actualValue);
    const expectedCanonicalValue = relationship.expectedValue === null
      ? null
      : normalizeAddress(relationship.expectedValue);
    return {
      sourceTable: relationship.sourceTable,
      sourceId: relationship.sourceId,
      relation: relationship.relation,
      result: actualCanonicalValue !== null &&
        expectedCanonicalValue !== null &&
        actualCanonicalValue === expectedCanonicalValue
        ? "consistent"
        : "mismatch",
      actualCanonicalValue,
      expectedCanonicalValue,
    };
  });
  const relationshipMismatches = relationshipResults.filter(
    (relationship) => relationship.result === "mismatch",
  );
  return {
    entries,
    invalid,
    collisions,
    relationships: relationshipResults,
    relationshipMismatches,
    canProceed: invalid.length === 0 &&
      collisions.length === 0 &&
      relationshipMismatches.length === 0,
  };
}

async function loadRows(
  admin: AdminClient,
  table: string,
  columns: string,
): Promise<Row[]> {
  const result = await query(admin, table).select(columns);
  if (result.error) throw result.error;
  return asRows(result.data);
}

function addIdentity(
  identities: HistoricalWalletIdentity[],
  sourceTable: string,
  sourceId: string,
  column: string,
  value: unknown,
  uniquenessScope?: string,
): void {
  if (typeof value === "string" || value === null) {
    identities.push({ sourceTable, sourceId, column, value, uniquenessScope });
  }
}

function addRelationship(
  relationships: HistoricalWalletRelationship[],
  sourceTable: string,
  sourceId: string,
  relation: string,
  actualValue: unknown,
  expectedValue: unknown,
): void {
  relationships.push({
    sourceTable,
    sourceId,
    relation,
    actualValue: typeof actualValue === "string" ? actualValue : null,
    expectedValue: typeof expectedValue === "string" ? expectedValue : null,
  });
}

interface HistoricalWalletAuditInput {
  identities: HistoricalWalletIdentity[];
  relationships: HistoricalWalletRelationship[];
}

/** Load all historical wallet identities needed by the pre-backfill gate. */
async function loadHistoricalWalletAuditInput(
  admin: AdminClient,
): Promise<HistoricalWalletAuditInput> {
  const [challenges, sessions, polls, votes, campaigns, funding, receipts, refunds, vaults] =
    await Promise.all([
      loadRows(admin, "wallet_challenges", "id, wallet_address"),
      loadRows(admin, "wallet_sessions", "token_hash, wallet_address"),
      loadRows(admin, "polls", "id, creator_wallet"),
      loadRows(admin, "poll_votes", "id, poll_id, voter_wallet"),
      loadRows(admin, "reward_campaigns", "id, poll_id, creator_wallet, funding_wallet, funding_mode"),
      loadRows(
        admin,
        "reward_funding_transactions",
        "id, campaign_id, creator_wallet, funder_wallet, vault_wallet",
      ),
      loadRows(admin, "reward_receipts", "id, campaign_id, participant_wallet"),
      loadRows(admin, "reward_refunds", "id, campaign_id, creator_wallet"),
      loadRows(admin, "reward_campaign_vaults", "campaign_id, vault_address_hex"),
    ]);

  const identities: HistoricalWalletIdentity[] = [];
  const relationships: HistoricalWalletRelationship[] = [];
  const campaignsById = new Map(campaigns.map((row) => [String(row.id), row]));
  const pollsById = new Map(polls.map((row) => [String(row.id), row]));
  const vaultsByCampaignId = new Map(vaults.map((row) => [String(row.campaign_id), row]));

  for (const row of challenges) addIdentity(identities, "wallet_challenges", String(row.id), "wallet_address", row.wallet_address);
  for (const row of sessions) addIdentity(identities, "wallet_sessions", String(row.token_hash), "wallet_address", row.wallet_address);
  for (const row of polls) addIdentity(identities, "polls", String(row.id), "creator_wallet", row.creator_wallet);
  for (const row of votes) {
    addIdentity(
      identities,
      "poll_votes",
      String(row.id),
      "voter_wallet",
      row.voter_wallet,
      `poll_votes:${String(row.poll_id)}`,
    );
  }
  for (const row of campaigns) {
    addIdentity(identities, "reward_campaigns", String(row.id), "creator_wallet", row.creator_wallet);
    addIdentity(identities, "reward_campaigns", String(row.id), "funding_wallet", row.funding_wallet);
  }
  for (const row of funding) {
    addIdentity(identities, "reward_funding_transactions", String(row.id), "creator_wallet", row.creator_wallet);
    addIdentity(identities, "reward_funding_transactions", String(row.id), "funder_wallet", row.funder_wallet);
    addIdentity(identities, "reward_funding_transactions", String(row.id), "vault_wallet", row.vault_wallet);
  }
  for (const row of receipts) {
    addIdentity(
      identities,
      "reward_receipts",
      String(row.id),
      "participant_wallet",
      row.participant_wallet,
      `reward_receipts:${String(row.campaign_id)}`,
    );
  }
  for (const row of refunds) addIdentity(identities, "reward_refunds", String(row.id), "creator_wallet", row.creator_wallet);
  for (const row of vaults) addIdentity(identities, "reward_campaign_vaults", String(row.campaign_id), "vault_address_hex", row.vault_address_hex);

  for (const campaign of campaigns) {
    const campaignId = String(campaign.id);
    const poll = pollsById.get(String(campaign.poll_id));
    addRelationship(
      relationships,
      "reward_campaigns",
      campaignId,
      "campaign_owner_matches_poll_owner",
      campaign.creator_wallet,
      poll?.creator_wallet,
    );
    if (campaign.funding_mode === "creator") {
      addRelationship(
        relationships,
        "reward_campaigns",
        campaignId,
        "creator_funding_matches_owner",
        campaign.funding_wallet,
        campaign.creator_wallet,
      );
    }
  }

  for (const fundingRow of funding) {
    const campaign = campaignsById.get(String(fundingRow.campaign_id));
    const vault = vaultsByCampaignId.get(String(fundingRow.campaign_id));
    const sourceId = String(fundingRow.id);
    addRelationship(
      relationships,
      "reward_funding_transactions",
      sourceId,
      "funding_creator_matches_owner",
      fundingRow.creator_wallet,
      campaign?.creator_wallet,
    );
    addRelationship(
      relationships,
      "reward_funding_transactions",
      sourceId,
      "funder_matches_designated_funder",
      fundingRow.funder_wallet,
      campaign?.funding_wallet,
    );
    addRelationship(
      relationships,
      "reward_funding_transactions",
      sourceId,
      "funding_vault_matches_campaign_vault",
      fundingRow.vault_wallet,
      vault?.vault_address_hex,
    );
  }

  for (const refundRow of refunds) {
    const campaign = campaignsById.get(String(refundRow.campaign_id));
    addRelationship(
      relationships,
      "reward_refunds",
      String(refundRow.id),
      "refund_recipient_matches_owner",
      refundRow.creator_wallet,
      campaign?.creator_wallet,
    );
  }

  return { identities, relationships };
}

export async function loadHistoricalWalletIdentities(
  admin: AdminClient,
): Promise<HistoricalWalletIdentity[]> {
  return (await loadHistoricalWalletAuditInput(admin)).identities;
}

export function auditCanonicalWalletRepresentation(
  identities: readonly HistoricalWalletIdentity[],
): WalletAuditReport;
export function auditCanonicalWalletRepresentation(
  admin: AdminClient,
): Promise<WalletAuditReport>;
export function auditCanonicalWalletRepresentation(
  input: readonly HistoricalWalletIdentity[] | AdminClient,
): WalletAuditReport | Promise<WalletAuditReport> {
  if (Array.isArray(input)) return buildCanonicalWalletAudit(input);
  return loadHistoricalWalletAuditInput(input as AdminClient).then(({ identities, relationships }) =>
    buildCanonicalWalletAudit(identities, relationships));
}

/** Run the application-side preflight without changing any historical row. */
export async function auditHistoricalWalletRepresentation(
  admin: AdminClient,
): Promise<WalletAuditReport> {
  const { identities, relationships } = await loadHistoricalWalletAuditInput(admin);
  return buildCanonicalWalletAudit(identities, relationships);
}

export interface RewardSettlementRoot {
  settlementId: string;
  ownerWallet: string;
  fundingWallet: string;
  refundRecipientWallet: string;
  fundingMode: "creator" | "community";
  asset: "NIM";
  rewardPerParticipantLuna: bigint;
  maxRewardedParticipants: number;
  rewardPrincipalLuna: bigint;
  feeReserveLuna: bigint;
  totalBudgetLuna: bigint;
  status: RewardCampaignState;
  fundedAmountLuna: bigint;
  refundableExcessLuna: bigint;
  rewardedParticipantCount: number;
  paidAmountLuna: bigint;
  feeSpentLuna: bigint;
  refundableAmountLuna: bigint;
  firstReservationAt: string | null;
  payoutLockAttemptId: string | null;
  payoutLockExpiresAt: string | null;
  payoutLockToken: string | null;
  createdAt: string;
  fundedAt: string | null;
  closedAt: string | null;
  refundedAt: string | null;
  updatedAt: string;
}

export type SettlementRootLoadResult =
  | { kind: "ok"; root: RewardSettlementRoot }
  | { kind: "not_found"; reasonCode: "settlement_not_found" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_settlement_root" };

function parseRoot(row: Row, settlementId: string): RewardSettlementRoot | null {
  const ownerWallet = canonicalRootWallet(row.owner_wallet);
  const fundingWallet = canonicalRootWallet(row.funding_wallet);
  const refundRecipientWallet = canonicalRootWallet(row.refund_recipient_wallet);
  const rewardPerParticipantLuna = integerLuna(row.reward_per_participant_luna);
  const rewardPrincipalLuna = integerLuna(row.reward_principal_luna);
  const feeReserveLuna = integerLuna(row.fee_reserve_luna);
  const totalBudgetLuna = integerLuna(row.total_budget_luna);
  const fundedAmountLuna = integerLuna(row.funded_amount_luna);
  const refundableExcessLuna = integerLuna(row.refundable_excess_luna);
  const paidAmountLuna = integerLuna(row.paid_amount_luna);
  const feeSpentLuna = integerLuna(row.fee_spent_luna);
  const refundableAmountLuna = integerLuna(row.refundable_amount_luna);
  const maxRewardedParticipants = safeInteger(row.max_rewarded_participants);
  const rewardedParticipantCount = safeInteger(row.rewarded_participant_count);
  const status = typeof row.status === "string" && isRewardCampaignState(row.status)
    ? row.status
    : null;
  const firstReservationAt = nullableString(row.first_reservation_at);
  const payoutLockAttemptId = nullableString(row.payout_lock_attempt_id);
  const payoutLockExpiresAt = nullableString(row.payout_lock_expires_at);
  const payoutLockToken = nullableString(row.payout_lock_token);
  const fundedAt = nullableString(row.funded_at);
  const closedAt = nullableString(row.closed_at);
  const refundedAt = nullableString(row.refunded_at);
  const createdAt = requiredString(row.created_at);
  const updatedAt = requiredString(row.updated_at);

  if (
    row.id !== settlementId ||
    ownerWallet === null ||
    fundingWallet === null ||
    refundRecipientWallet === null ||
    row.funding_mode !== "creator" && row.funding_mode !== "community" ||
    row.asset !== "NIM" ||
    rewardPerParticipantLuna === null ||
    rewardPrincipalLuna === null ||
    feeReserveLuna === null ||
    totalBudgetLuna === null ||
    fundedAmountLuna === null ||
    refundableExcessLuna === null ||
    paidAmountLuna === null ||
    feeSpentLuna === null ||
    refundableAmountLuna === null ||
    maxRewardedParticipants === null ||
    maxRewardedParticipants <= 0 ||
    rewardedParticipantCount === null ||
    rewardedParticipantCount > maxRewardedParticipants ||
    status === null ||
    firstReservationAt === undefined ||
    payoutLockAttemptId === undefined ||
    payoutLockExpiresAt === undefined ||
    payoutLockToken === undefined ||
    fundedAt === undefined ||
    closedAt === undefined ||
    refundedAt === undefined ||
    createdAt === null ||
    updatedAt === null ||
    rewardPrincipalLuna !== rewardPerParticipantLuna * BigInt(maxRewardedParticipants) ||
    totalBudgetLuna !== rewardPrincipalLuna + feeReserveLuna ||
    paidAmountLuna + feeSpentLuna > fundedAmountLuna ||
    refundRecipientWallet !== ownerWallet && refundRecipientWallet !== fundingWallet
  ) {
    return null;
  }

  return {
    settlementId,
    ownerWallet,
    fundingWallet,
    refundRecipientWallet,
    fundingMode: row.funding_mode,
    asset: "NIM",
    rewardPerParticipantLuna,
    maxRewardedParticipants,
    rewardPrincipalLuna,
    feeReserveLuna,
    totalBudgetLuna,
    status,
    fundedAmountLuna,
    refundableExcessLuna,
    rewardedParticipantCount,
    paidAmountLuna,
    feeSpentLuna,
    refundableAmountLuna,
    firstReservationAt,
    payoutLockAttemptId,
    payoutLockExpiresAt,
    payoutLockToken,
    createdAt,
    fundedAt,
    closedAt,
    refundedAt,
    updatedAt,
  };
}

/** Read-only root snapshot loader. It does not load a Poll or vault row. */
export async function loadRewardSettlementContext(
  admin: AdminClient,
  settlementId: string,
): Promise<SettlementRootLoadResult> {
  const result = await query(admin, "reward_settlements")
    .select("*")
    .eq("id", settlementId)
    .maybeSingle();
  if (result.error) return { kind: "error", reasonCode: "database_read_failed" };
  const row = asRow(result.data);
  if (!row) return { kind: "not_found", reasonCode: "settlement_not_found" };
  const root = parseRoot(row, settlementId);
  return root
    ? { kind: "ok", root }
    : { kind: "error", reasonCode: "malformed_settlement_root" };
}

export interface PollSettlementBinding {
  settlementId: string;
  rewardCampaignId: string;
  pollId: string;
  sourceType: "poll_reward_campaign";
}

export type PollSettlementResolution =
  | {
      kind: "ok";
      settlementId: string;
      rewardCampaignId: string;
      pollId: string;
      sourceType: "poll_reward_campaign";
      ownerWallet: string;
    }
  | { kind: "not_found"; reasonCode: "settlement_not_found" }
  | { kind: "error"; reasonCode: "database_read_failed" | "malformed_settlement_binding" };

/** Resolve and validate the Poll source relationship without changing authority. */
export async function resolvePollRewardSettlement(
  admin: AdminClient,
  pollId: string,
): Promise<PollSettlementResolution> {
  const campaignResult = await query(admin, "reward_campaigns")
    .select("id, poll_id, settlement_id, creator_wallet")
    .eq("poll_id", pollId)
    .maybeSingle();
  if (campaignResult.error) return { kind: "error", reasonCode: "database_read_failed" };
  const campaign = asRow(campaignResult.data);
  if (!campaign) return { kind: "not_found", reasonCode: "settlement_not_found" };

  const campaignId = requiredString(campaign.id);
  const campaignPollId = requiredString(campaign.poll_id);
  const stagingSettlementId = requiredString(campaign.settlement_id);
  const campaignOwner = typeof campaign.creator_wallet === "string"
    ? normalizeAddress(campaign.creator_wallet)
    : null;
  if (!campaignId || !campaignPollId || !stagingSettlementId || campaignPollId !== pollId || !campaignOwner) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  const pollResult = await query(admin, "polls")
    .select("id, creator_wallet")
    .eq("id", pollId)
    .maybeSingle();
  if (pollResult.error) return { kind: "error", reasonCode: "database_read_failed" };
  const poll = asRow(pollResult.data);
  const pollOwner = poll && typeof poll.creator_wallet === "string"
    ? normalizeAddress(poll.creator_wallet)
    : null;
  if (!poll || poll.id !== pollId || !pollOwner || pollOwner !== campaignOwner) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  const bindingResult = await query(admin, "settlement_source_bindings")
    .select("settlement_id, source_type, reward_campaign_id")
    .eq("reward_campaign_id", campaignId)
    .maybeSingle();
  if (bindingResult.error) return { kind: "error", reasonCode: "database_read_failed" };
  const binding = asRow(bindingResult.data);
  if (
    !binding ||
    binding.source_type !== "poll_reward_campaign" ||
    binding.reward_campaign_id !== campaignId ||
    binding.settlement_id !== stagingSettlementId
  ) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  const root = await loadRewardSettlementContext(admin, stagingSettlementId);
  if (root.kind === "not_found") return root;
  if (root.kind === "error") {
    if (root.reasonCode === "database_read_failed") {
      return { kind: "error", reasonCode: "database_read_failed" };
    }
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }
  if (root.root.ownerWallet !== campaignOwner) {
    return { kind: "error", reasonCode: "malformed_settlement_binding" };
  }

  return {
    kind: "ok",
    settlementId: stagingSettlementId,
    rewardCampaignId: campaignId,
    pollId,
    sourceType: "poll_reward_campaign",
    ownerWallet: root.root.ownerWallet,
  };
}
