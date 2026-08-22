"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDraft, createDraft, updateDraft } from "./storage";
import type { PollDraft, DraftStep, DraftStatus } from "./types";

interface DraftFormData {
  question: string;
  context: string;
  options: string[];
  contributionMode: "creator" | "community" | null;
  purpose: string;
  destinationWallet: string;
  minimumNim: string;
  duration: string;
  reward?: {
    enabled: boolean;
    rewardPerParticipant?: string;
    maxRewardedParticipants?: string;
  };
}

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

  // Keep refs current with latest props/state for use in callbacks
  // eslint-disable-next-line react-hooks/refs -- intentional sync of refs to latest values during render
  formRef.current = formData;
  // eslint-disable-next-line react-hooks/refs -- intentional sync of refs to latest values during render
  stepRef.current = currentStep;

  const flush = useCallback(() => {
    const id = idRef.current;
    if (!id) return;
    const data = formRef.current;
    const step = stepRef.current;
    if (initialized.current) {
      updateDraft(id, {
        question: data.question,
        context: data.context,
        options: data.options,
        contributionMode: data.contributionMode,
        destinationWallet: data.destinationWallet,
        purpose: data.purpose,
        minimumNim: data.minimumNim,
        duration: data.duration,
        ...(data.reward ? { reward: data.reward } : {}),
        currentStep: step,
      });
    }
  }, []);

  const debouncedSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 500);
  }, [flush]);

  const saveImmediately = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    flush();
  }, [flush]);

  // Initialize or load draft
  useEffect(() => {
    if (initialized.current) return;

    if (draftId) {
      const existing = getDraft(draftId);
      if (existing) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- loading draft on init
        setDraft(existing);
        idRef.current = draftId;
        initialized.current = true;
        return;
      }
    }

    // New drafts are created on first meaningful input below
  }, [draftId]);

  // Create draft on first meaningful input
  useEffect(() => {
    if (initialized.current) return;
    if (idRef.current) return;
    const data = formRef.current;
    const hasContent =
      data.question.trim() ||
      data.options.some((o) => o.trim()) ||
      data.context.trim() ||
      data.purpose.trim() ||
      data.destinationWallet.trim() ||
      data.minimumNim.trim() ||
      data.duration ||
      (data.reward?.enabled ?? false);
    if (!hasContent) return;

    const newId = generateId();
    idRef.current = newId;
    const now = new Date().toISOString();
    const newDraft: PollDraft = {
      id: newId,
      question: data.question,
      context: data.context,
      options: data.options,
      contributionMode: data.contributionMode,
      destinationWallet: data.destinationWallet,
      purpose: data.purpose,
      minimumNim: data.minimumNim,
      duration: data.duration,
      ...(data.reward ? { reward: data.reward } : {}),
      category: "communities",
      format: "decision",
      currentStep: stepRef.current,
      status: "editing",
      createdAt: now,
      updatedAt: now,
    };
    createDraft(newDraft);
    setDraft(newDraft);
    initialized.current = true;
  }, [
    formData.question,
    formData.options,
    formData.context,
    formData.purpose,
    formData.destinationWallet,
    formData.minimumNim,
    formData.duration,
  ]);

  // Autosave on data changes
  useEffect(() => {
    if (!initialized.current) return;
    debouncedSave();
  }, [
    formData.question,
    formData.context,
    formData.options,
    formData.contributionMode,
    formData.purpose,
    formData.destinationWallet,
    formData.minimumNim,
    formData.duration,
    currentStep,
    debouncedSave,
  ]);

  // Save immediately on step change
  const prevStep = useRef(currentStep);
  useEffect(() => {
    if (prevStep.current !== currentStep && initialized.current) {
      saveImmediately();
    }
    prevStep.current = currentStep;
  }, [currentStep, saveImmediately]);

  // Cleanup timer on unmount
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
