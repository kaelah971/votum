import "server-only";

import {
  executeRewardRefund,
  type RewardRefundResult,
} from "@/lib/rewards/refund";
import type {
  RewardClosureContext,
  RewardClosureService as RewardClosureServiceContract,
  RewardClosureTrigger,
} from "@/lib/rewards/participation";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = NonNullable<ReturnType<typeof createAdminClient>>;

export type {
  RewardClosureAuthorization,
  RewardClosureContext,
  RewardClosureTrigger,
} from "@/lib/rewards/participation";

export type RewardClosurePreparationResult =
  | { kind: "created" | "replay"; settlementId: string; refundId: string }
  | { kind: "nothing_to_refund" | "already_refunded_or_closed"; settlementId: string }
  | { kind: "error"; reasonCode: string };

export type RewardClosureService = RewardClosureServiceContract<
  RewardClosurePreparationResult,
  RewardRefundResult
>;

export interface RewardClosureStore {
  revalidateTrigger(trigger: RewardClosureTrigger): Promise<boolean>;
  beginRefund(settlementId: string, sessionTokenHash: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isClosureReason(value: unknown): value is RewardClosureTrigger["reason"] {
  return value === "source_closed" || value === "elapsed" || value === "expired" ||
    value === "creator_cancelled" || value === "source_specific";
}

function isClosureContext(value: unknown): value is RewardClosureContext {
  if (!isRecord(value) || !hasExactKeys(value, ["trigger"]) || !isRecord(value.trigger)) return false;
  const trigger = value.trigger;
  if (
    !hasExactKeys(trigger, ["source", "settlement", "reason", "observedAt"]) ||
    !isRecord(trigger.source) ||
    !isRecord(trigger.settlement) ||
    !isClosureReason(trigger.reason) ||
    !nonEmptyString(trigger.observedAt) ||
    Number.isNaN(Date.parse(trigger.observedAt))
  ) return false;

  const source = trigger.source;
  const settlement = trigger.settlement;
  if (
    !hasExactKeys(source, ["type", "id"]) ||
    !hasExactKeys(settlement, ["id", "binding"]) ||
    !isRecord(settlement.binding) ||
    !nonEmptyString(source.id) ||
    !nonEmptyString(settlement.id) ||
    !nonEmptyString(settlement.binding.sourceId) ||
    (source.type !== "poll_vote" && source.type !== "campaign_claim") ||
    settlement.binding.sourceType !== source.type ||
    settlement.binding.sourceId !== source.id
  ) return false;

  return true;
}

function preparationError(reasonCode: string): RewardClosurePreparationResult {
  return { kind: "error", reasonCode };
}

function parsePreparationResult(
  raw: unknown,
  settlementId: string,
): RewardClosurePreparationResult {
  if (!isRecord(raw) || typeof raw.result_kind !== "string") {
    return preparationError("refund_preparation_failed");
  }

  const resultKind = raw.result_kind;
  if (resultKind === "created" || resultKind === "replay") {
    if (raw.campaign_id !== settlementId || typeof raw.refund_id !== "string" || !raw.refund_id) {
      return preparationError("malformed_refund_preparation");
    }
    return { kind: resultKind, settlementId, refundId: raw.refund_id };
  }

  if (resultKind === "nothing_to_refund" || resultKind === "already_refunded_or_closed") {
    if (raw.campaign_id !== settlementId) return preparationError("malformed_refund_preparation");
    return { kind: resultKind, settlementId };
  }

  return preparationError(resultKind);
}

export function createRewardClosureService(
  store: RewardClosureStore,
  executeRefund: (settlementId: string, refundId: string) => Promise<RewardRefundResult>,
): RewardClosureService {
  return {
    async prepareRefund(context, authorization) {
      if (!isClosureContext(context)) return preparationError("invalid_closure_context");
      if (!authorization || !nonEmptyString(authorization.sessionTokenHash)) {
        return preparationError("forbidden");
      }

      try {
        if (!await store.revalidateTrigger(context.trigger)) {
          return preparationError("source_trigger_stale");
        }
        const raw = await store.beginRefund(
          context.trigger.settlement.id,
          authorization.sessionTokenHash,
        );
        return parsePreparationResult(raw, context.trigger.settlement.id);
      } catch {
        return preparationError("refund_preparation_failed");
      }
    },
    executeRefund,
  };
}

export function createSupabaseRewardClosureService(
  admin: AdminClient,
  revalidateTrigger: (trigger: RewardClosureTrigger) => Promise<boolean>,
): RewardClosureService {
  const store: RewardClosureStore = {
    revalidateTrigger,
    async beginRefund(settlementId, sessionTokenHash) {
      const { data, error } = await admin.rpc("begin_reward_refund_atomic", {
        _campaign_id: settlementId,
        _session_token_hash: sessionTokenHash,
      });
      if (error) throw new Error("begin_reward_refund_atomic_failed");
      return data;
    },
  };

  return createRewardClosureService(
    store,
    (settlementId, refundId) => executeRewardRefund(admin, refundId, settlementId),
  );
}
