import { describe, expect, it } from "vitest";
import { normalizePollDraft } from "@/lib/drafts/types";

const baseDraft = {
  id: "draft-1",
  question: "Which option should we choose?",
  context: "",
  options: ["A", "B"],
  duration: "7days",
  category: "communities" as const,
  format: "decision" as const,
  status: "editing" as const,
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

describe("poll draft normalization", () => {
  it("classifies an old support-shaped draft as legacy support", () => {
    const draft = normalizePollDraft({
      ...baseDraft,
      currentStep: "support",
      contributionMode: "creator",
      destinationWallet: "NQ-CREATOR",
      purpose: "Project costs",
      minimumNim: "1",
    });

    expect(draft).toMatchObject({
      economicModel: "legacy_support",
      rewardMode: null,
      currentStep: "support",
      contributionMode: "creator",
      destinationWallet: "NQ-CREATOR",
    });
  });

  it("keeps reward-first drafts on the Rewards step without support keys", () => {
    const draft = normalizePollDraft({
      ...baseDraft,
      currentStep: "rewards",
      economicModel: "reward_first",
      rewardMode: "free",
      destinationWallet: "must be discarded",
      purpose: "must be discarded",
    });

    expect(draft).toMatchObject({
      economicModel: "reward_first",
      rewardMode: "free",
      currentStep: "rewards",
    });
    expect(draft).not.toHaveProperty("destinationWallet");
    expect(draft).not.toHaveProperty("purpose");
  });

  it("rejects a draft with an unknown explicit discriminator", () => {
    expect(
      normalizePollDraft({ ...baseDraft, economicModel: "unknown" }),
    ).toBeNull();
  });
});
