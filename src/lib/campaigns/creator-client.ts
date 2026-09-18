/**
 * Browser-safe typed client for the Campaign creator APIs.
 *
 * Thin fetch wrappers over the existing server truth: paths, methods,
 * request shapes, and response/error vocabularies mirror the routes
 * exactly. Session identity stays server-derived (cookies travel with
 * same-origin fetch); the client never sends wallets, vaults, amounts,
 * settlements, or any other authority-controlled field. The creator refund
 * surface is a single idempotent trigger (C5); all refund economics stay
 * server-derived.
 */

export interface CampaignCreatorError {
  code: string;
  status: number;
  message?: string;
}

/** Narrow create/update input: product fields only, never authority fields. */
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
}

export type CreatorResult<T> = T | { kind: "error"; error: CampaignCreatorError };

export interface CreatedCampaign {
  kind: "created";
  campaign: unknown;
}

export interface UpdatedCampaign {
  kind: "updated";
  campaign: unknown;
}

export interface LoadedReadiness {
  kind: "loaded";
  campaign: unknown;
  fundingReadiness: unknown;
}

export interface CreatedFundingIntent {
  kind: "created" | "replay";
  fundingIntent: unknown;
}

export interface BoundFunding {
  kind: "bound" | "bound_replay";
  binding: unknown;
}

export interface ConfirmedFunding {
  kind: "confirmed" | "replay" | "reconciled";
  confirmation: unknown;
}

export interface PublishedCampaign {
  kind: "published";
  campaign: unknown;
}

export interface LoadedPublicCampaign {
  kind: "loaded";
  campaign: unknown;
}

export interface ClosedCampaign {
  kind: "closed";
  settlementId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readError(body: unknown, status: number): CampaignCreatorError {
  if (isRecord(body)) {
    const code = typeof body.reasonCode === "string" && body.reasonCode.length > 0
      ? body.reasonCode
      : typeof body.error === "string" && body.error.length > 0
        ? body.error
        : "request_failed";
    const message = typeof body.message === "string" && body.message.length > 0
      ? body.message
      : undefined;
    return message === undefined ? { code, status } : { code, status, message };
  }
  return { code: "request_failed", status };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown }> {
  let response: Response;
  try {
    response = init === undefined ? await fetch(path) : await fetch(path, init);
  } catch {
    return { ok: false, status: 0, body: null };
  }
  return { ok: response.ok, status: response.status, body: await readJson(response) };
}

function failure(status: number, body: unknown): { kind: "error"; error: CampaignCreatorError } {
  return { kind: "error", error: readError(body, status) };
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export async function createCampaign(
  input: CampaignConfigurationInput,
): Promise<CreatorResult<CreatedCampaign>> {
  const { ok, status, body } = await requestJson("/api/campaigns", {
    method: "POST",
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(input),
  });
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("campaign" in body)) {
    return failure(status, null);
  }
  return { kind: "created", campaign: body.campaign };
}

export async function updateCampaign(
  campaignId: string,
  input: CampaignConfigurationInput,
): Promise<CreatorResult<UpdatedCampaign>> {
  const { ok, status, body } = await requestJson(`/api/campaigns/${campaignId}`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS },
    body: JSON.stringify(input),
  });
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("campaign" in body)) {
    return failure(status, null);
  }
  return { kind: "updated", campaign: body.campaign };
}

export async function getCampaignFundingReadiness(
  campaignId: string,
): Promise<CreatorResult<LoadedReadiness>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/funding-readiness`,
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("campaign" in body) || !("fundingReadiness" in body)) {
    return failure(status, null);
  }
  return { kind: "loaded", campaign: body.campaign, fundingReadiness: body.fundingReadiness };
}

export async function createCampaignFundingIntent(
  campaignId: string,
): Promise<CreatorResult<CreatedFundingIntent>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/funding/intents`,
    { method: "POST" },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("fundingIntent" in body)) {
    return failure(status, null);
  }
  return {
    kind: body.resultKind === "replay" ? "replay" : "created",
    fundingIntent: body.fundingIntent,
  };
}

export async function bindCampaignFunding(
  campaignId: string,
  intentId: string,
  transactionHash: string,
): Promise<CreatorResult<BoundFunding>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/funding/intents/${intentId}/bind`,
    {
      method: "POST",
      headers: { ...JSON_HEADERS },
      body: JSON.stringify({ transactionHash }),
    },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("binding" in body)) {
    return failure(status, null);
  }
  return {
    kind: body.resultKind === "bound_replay" ? "bound_replay" : "bound",
    binding: body.binding,
  };
}

export async function confirmCampaignFunding(
  campaignId: string,
  intentId: string,
): Promise<CreatorResult<ConfirmedFunding>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/funding/intents/${intentId}/confirm`,
    { method: "POST" },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("confirmation" in body)) {
    return failure(status, null);
  }
  const confirmation = body.confirmation;
  const kind = isRecord(confirmation) && confirmation.kind === "replay"
    ? "replay"
    : isRecord(confirmation) && confirmation.kind === "reconciled"
      ? "reconciled"
      : "confirmed";
  return { kind, confirmation };
}

export async function publishCampaign(
  campaignId: string,
): Promise<CreatorResult<PublishedCampaign>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/publish`,
    { method: "POST" },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || !("campaign" in body)) {
    return failure(status, null);
  }
  return { kind: "published", campaign: body.campaign };
}

export async function getPublicCampaign(
  campaignId: string,
): Promise<CreatorResult<LoadedPublicCampaign>> {
  const { ok, status, body } = await requestJson(`/api/campaigns/${campaignId}/public`);
  if (!ok) return failure(status, body);
  if (!isRecord(body)) {
    return failure(status, null);
  }
  return { kind: "loaded", campaign: body };
}

export async function closeCampaign(
  campaignId: string,
): Promise<CreatorResult<ClosedCampaign>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/close`,
    { method: "POST" },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body) || typeof body.settlementId !== "string") {
    return failure(status, null);
  }
  return { kind: "closed", settlementId: body.settlementId };
}

export interface ProcessedCampaignRefund {
  kind: "processed";
  refundId: string;
  status: string;
  transactionHash: string | null;
}

export interface TerminalCampaignRefund {
  kind: "refunded";
}

export async function refundCampaign(
  campaignId: string,
): Promise<CreatorResult<ProcessedCampaignRefund | TerminalCampaignRefund>> {
  const { ok, status, body } = await requestJson(
    `/api/campaigns/${campaignId}/refund`,
    { method: "POST" },
  );
  if (!ok) return failure(status, body);
  if (!isRecord(body)) {
    return failure(status, null);
  }
  if (typeof body.refundId === "string" && typeof body.status === "string") {
    return {
      kind: "processed",
      refundId: body.refundId,
      status: body.status,
      transactionHash:
        typeof body.transactionHash === "string" ? body.transactionHash : null,
    };
  }
  if (body.status === "refunded") {
    return { kind: "refunded" };
  }
  return failure(status, null);
}
