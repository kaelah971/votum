"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDraft, createDraft, updateDraft } from "./storage";
import {
  normalizePollDraft,
  type DraftFormData,
  type DraftStep,
  type DraftStatus,
  type LegacyDraftStep,
  type PollDraft,
  type RewardFirstDraftStep,
} from "./types";

interface UsePollDraftOptions {
  draftId: string | null;
  formData: DraftFormData;
  currentStep: DraftStep;
}

interface UsePollDraftReturn {
  draft: PollDraft | null;
  setDraftStatus: (status: DraftStatus) => void;
  saveImmediately: () => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function legacyStep(step: DraftStep): LegacyDraftStep {
  return step === "rewards" ? "support" : step;
}

function rewardFirstStep(step: DraftStep): RewardFirstDraftStep {
  return step === "support" ? "rewards" : step;
}

/**
 * Build the persisted fields from the active form model. Keeping this branch
 * explicit prevents a new reward-first draft from acquiring legacy support
 * placeholders through a shared form serializer.
 */
function draftFields(data: DraftFormData, step: DraftStep): Partial<PollDraft> {
  const common = {
    category: data.category,
    format: data.format,
    question: data.question,
    context: data.context,
    options: data.options,
    duration: data.duration,
  };

  if (data.economicModel === "legacy_support") {
    return {
      ...common,
      currentStep: legacyStep(step),
      economicModel: "legacy_support",
      rewardMode: null,
      contributionMode: data.contributionMode,
      destinationWallet: data.destinationWallet,
      purpose: data.purpose,
      minimumNim: data.minimumNim,
      reward: {
        enabled: data.rewardEnabled,
        rewardPerParticipant: data.rewardPerParticipant,
        maxRewardedParticipants: data.maxRewardedParticipants,
      },
    };
  }

  return {
    ...common,
    currentStep: rewardFirstStep(step),
    economicModel: "reward_first",
    rewardMode: data.rewardMode,
    ...(data.rewardMode === "rewarded"
      ? {
          ...(data.rewardFundingMode
            ? { rewardFundingMode: data.rewardFundingMode }
            : {}),
          ...(data.fundingWallet?.trim()
            ? { fundingWallet: data.fundingWallet }
            : {}),
          ...(data.rewardPerParticipant !== undefined
            ? { rewardPerParticipant: data.rewardPerParticipant }
            : {}),
          ...(data.maxRewardedParticipants !== undefined
            ? { maxRewardedParticipants: data.maxRewardedParticipants }
            : {}),
        }
      : {
          rewardFundingMode: undefined,
          fundingWallet: undefined,
          rewardPerParticipant: undefined,
          maxRewardedParticipants: undefined,
          reward: undefined,
        }),
  };
}

function newDraftFromForm(
  id: string,
  data: DraftFormData,
  currentStep: DraftStep,
  now: string,
): PollDraft {
  if (data.economicModel === "legacy_support") {
    return {
      id,
      category: data.category,
      format: data.format,
      question: data.question,
      context: data.context,
      options: data.options,
      duration: data.duration,
      currentStep: legacyStep(currentStep),
      status: "editing",
      createdAt: now,
      updatedAt: now,
      economicModel: "legacy_support",
      rewardMode: null,
      contributionMode: data.contributionMode,
      destinationWallet: data.destinationWallet,
      purpose: data.purpose,
      minimumNim: data.minimumNim,
      reward: {
        enabled: data.rewardEnabled,
        rewardPerParticipant: data.rewardPerParticipant,
        maxRewardedParticipants: data.maxRewardedParticipants,
      },
    };
  }

  return {
    id,
    category: data.category,
    format: data.format,
    question: data.question,
    context: data.context,
    options: data.options,
    duration: data.duration,
    currentStep: rewardFirstStep(currentStep),
    status: "editing",
    createdAt: now,
    updatedAt: now,
    economicModel: "reward_first",
    rewardMode: data.rewardMode,
    ...(data.rewardMode === "rewarded"
      ? {
          ...(data.rewardFundingMode
            ? { rewardFundingMode: data.rewardFundingMode }
            : {}),
          ...(data.fundingWallet?.trim()
            ? { fundingWallet: data.fundingWallet }
            : {}),
          ...(data.rewardPerParticipant !== undefined
            ? { rewardPerParticipant: data.rewardPerParticipant }
            : {}),
          ...(data.maxRewardedParticipants !== undefined
            ? { maxRewardedParticipants: data.maxRewardedParticipants }
            : {}),
        }
      : {
          rewardFundingMode: undefined,
          fundingWallet: undefined,
          rewardPerParticipant: undefined,
          maxRewardedParticipants: undefined,
          reward: undefined,
        }),
  };
}

export function usePollDraft({
  draftId,
  formData,
  currentStep,
}: UsePollDraftOptions): UsePollDraftReturn {
  const [draft, setDraft] = useState<PollDraft | null>(null);
  const idRef = useRef<string | null>(draftId);
  const formRef = useRef(formData);
  const stepRef = useRef(currentStep);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialized = useRef(false);
  const skipAutosaveAfterLoad = useRef(false);

  // Keep refs current with latest props/state for use in callbacks.
  // eslint-disable-next-line react-hooks/refs -- intentional sync of refs to latest values during render
  formRef.current = formData;
  // eslint-disable-next-line react-hooks/refs -- intentional sync of refs to latest values during render
  stepRef.current = currentStep;

  const flush = useCallback(() => {
    const id = idRef.current;
    if (!id || !initialized.current) return;
    updateDraft(id, draftFields(formRef.current, stepRef.current));
  }, []);

  const debouncedSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 500);
  }, [flush]);

  const saveImmediately = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    flush();
  }, [flush]);

  // Initialize or load draft.
  useEffect(() => {
    if (initialized.current) return;

    if (draftId) {
      const existing = getDraft(draftId);
      const normalized = normalizePollDraft(existing);
      if (normalized) {
        // Do not autosave the first-render defaults over a restored draft. The
        // Create page restores its fields in the following render.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setDraft(normalized);
        idRef.current = draftId;
        initialized.current = true;
        skipAutosaveAfterLoad.current = true;
        return;
      }
    }

    // New drafts are created on first meaningful input below.
  }, [draftId]);

  // Create draft on first meaningful input.
  useEffect(() => {
    if (initialized.current) return;
    if (idRef.current) return;
    const data = formRef.current;
    const hasContent =
      data.question.trim() ||
      data.options.some((o) => o.trim()) ||
      data.context.trim() ||
      data.duration ||
      (data.economicModel === "legacy_support"
        ? data.purpose.trim() ||
          data.destinationWallet.trim() ||
          data.minimumNim.trim() ||
          data.rewardEnabled
        : Boolean(
            data.fundingWallet?.trim() ||
              data.rewardPerParticipant?.trim() ||
              data.maxRewardedParticipants?.trim(),
          ));
    if (!hasContent) return;

    const newId = generateId();
    idRef.current = newId;
    const now = new Date().toISOString();
    const newDraft = newDraftFromForm(newId, data, stepRef.current, now);
    createDraft(newDraft);
    setDraft(newDraft);
    initialized.current = true;
  }, [formData]);

  // Autosave on data changes.
  useEffect(() => {
    if (!initialized.current) return;
    if (skipAutosaveAfterLoad.current) {
      skipAutosaveAfterLoad.current = false;
      return;
    }
    debouncedSave();
  }, [formData, currentStep, debouncedSave]);

  // Save immediately on step change.
  const prevStep = useRef(currentStep);
  useEffect(() => {
    if (prevStep.current !== currentStep && initialized.current) {
      saveImmediately();
    }
    prevStep.current = currentStep;
  }, [currentStep, saveImmediately]);

  // Cleanup timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const setDraftStatus = useCallback(
    (status: DraftStatus) => {
      const id = idRef.current;
      if (!id) return;
      updateDraft(id, { status });
      setDraft((prev) => (prev ? { ...prev, status } : null));
    },
    [],
  );

  return { draft, setDraftStatus, saveImmediately };
}
