import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRewardParticipationContext,
  type RewardParticipationContext,
} from "@/lib/rewards/participation";

const PARTICIPANT = "01" + "a".repeat(38);
const OWNER = "02" + "b".repeat(38);

function context(): RewardParticipationContext {
  return {
    source: {
      type: "poll_vote",
      id: "vote-1",
    },
    participantWallet: PARTICIPANT,
    ownerWallet: OWNER,
    eligibility: {
      evidenceId: "vote-1",
      evidenceKind: "verified_wallet_vote",
      verifiedAt: "2026-09-13T00:00:00.000Z",
    },
    settlement: {
      id: "settlement-1",
      binding: {
        sourceType: "poll_vote",
        sourceId: "poll-1",
      },
    },
  };
}

describe("RewardParticipationContext", () => {
  it("accepts the minimal server-produced participation shape", () => {
    expect(parseRewardParticipationContext(context())).toEqual(context());
  });

  it.each([
    "rewardAmountLuna",
    "capacity",
    "rewardedParticipantCount",
    "vaultAddressHex",
    "settlementStatus",
    "first_reservation_at",
    "principal",
    "feeReserve",
    "fundingState",
    "optionId",
    "selectedOptionId",
  ])("rejects a context carrying forbidden field %s", (field) => {
    const candidate = { ...context(), [field]: field === "capacity" ? 1 : "forged" };

    expect(parseRewardParticipationContext(candidate)).toBeNull();
  });

  it("rejects forbidden nested settlement and eligibility fields", () => {
    expect(parseRewardParticipationContext({
      ...context(),
      settlement: {
        ...context().settlement,
        status: "funded",
        vaultAddressHex: "forged",
      },
      eligibility: {
        ...context().eligibility,
        rewardAmountLuna: "forged",
      },
    })).toBeNull();
  });

  it("requires source, evidence, and settlement binding types to agree", () => {
    expect(parseRewardParticipationContext({
      ...context(),
      source: { type: "campaign_claim", id: "claim-1" },
    })).toBeNull();
    expect(parseRewardParticipationContext({
      ...context(),
      eligibility: {
        ...context().eligibility,
        evidenceKind: "verified_wallet_claim",
      },
    })).toBeNull();
    expect(parseRewardParticipationContext({
      ...context(),
      settlement: {
        ...context().settlement,
        binding: { sourceType: "campaign_claim", sourceId: "poll-1" },
      },
    })).toBeNull();
  });

  it.each([
    "source",
    "participantWallet",
    "ownerWallet",
    "eligibility",
    "settlement",
  ])("rejects a context missing %s", (field) => {
    const candidate = { ...context() } as Record<string, unknown>;
    delete candidate[field];

    expect(parseRewardParticipationContext(candidate)).toBeNull();
  });

  it("rejects browser authority fields rather than treating them as server truth", () => {
    expect(parseRewardParticipationContext({
      ...context(),
      eligible: true,
      participantWallet: "browser-wallet",
      ownerWallet: "browser-owner",
      settlementId: "browser-settlement",
      rewardAmountLuna: "1",
    })).toBeNull();
  });

  it("uses only the server-only module boundary", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/rewards/participation.ts"),
      "utf8",
    );
    const participationStart = source.indexOf("export interface RewardParticipationContext");
    const participationEnd = source.indexOf("export interface RewardSettlementContext");
    const participationSource = participationEnd === -1
      ? source.slice(participationStart)
      : source.slice(participationStart, participationEnd);

    expect(source).toContain('import "server-only"');
    expect(source).not.toMatch(/NextRequest|NextResponse|cookies\(|request\.json/);
    expect(participationSource).not.toMatch(/rewardAmountLuna|vaultAddressHex|first_reservation_at/);
  });

  it("does not expose selected-option or financial fields in serialized context", () => {
    const serialized = JSON.stringify(
      parseRewardParticipationContext(context()),
    );

    expect(serialized).not.toMatch(/option|choice|selected|rewardAmount|capacity|vault|principal|fee|funding|status/i);
  });
});
