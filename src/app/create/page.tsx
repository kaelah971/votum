"use client";

import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from "react";
import { ProductShell } from "@/components/layout/ProductShell";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { ProofPath } from "@/components/ui/ProofPath";
import { FairnessLabel } from "@/components/ui/FairnessLabel";
import { PollOptionsEditor } from "@/components/decision/PollOptionsEditor";
import { ContributionModeSelector } from "@/components/decision/ContributionModeSelector";
import { PollReview } from "@/components/decision/PollReview";
import { CreateGate } from "@/components/creator/CreateGate";
import { formatClosingTime, truncateAddress } from "@/lib/format";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useOnboarding } from "@/providers/OnboardingProvider";
import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { usePollDraft } from "@/lib/drafts/usePollDraft";
import { getDraft, ensurePublicationKey, deleteDraft } from "@/lib/drafts/storage";
import { CATEGORY_LABELS, FORMAT_LABELS, POLL_CATEGORIES, POLL_FORMATS } from "@/lib/polls/taxonomy";
import type { PollCategory, PollFormat } from "@/lib/polls/taxonomy";
import { validateRewardConfigInput } from "@/lib/rewards/config";
import { formatNimAmount } from "@/lib/nimiq/units";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PollFormData {
  category: PollCategory;
  format: PollFormat;
  question: string;
  context: string;
  options: string[];
  contributionMode: "creator" | "community" | null;
  purpose: string;
  destinationWallet: string;
  minimumNim: string;
  duration: string;
  rewardEnabled: boolean;
  rewardPerParticipant: string;
  maxRewardedParticipants: string;
}

interface DecisionErrors {
  question?: string;
  options?: string;
}

interface SupportErrors {
  contributionMode?: string;
  purpose?: string;
  destinationWallet?: string;
  minimumNim?: string;
  duration?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_FORM_DATA: PollFormData = {
  category: "communities",
  format: "decision",
  question: "",
  context: "",
  options: ["", ""],
  contributionMode: null,
  purpose: "",
  destinationWallet: "",
  minimumNim: "",
  duration: "",
  rewardEnabled: false,
  rewardPerParticipant: "",
  maxRewardedParticipants: "",
};

const QUESTION_MIN_LENGTH = 10;
const QUESTION_MAX_LENGTH = 200;
const PURPOSE_MIN_LENGTH = 5;

const DURATION_OPTIONS = [
  { value: "1day", label: "1 day" },
  { value: "3days", label: "3 days" },
  { value: "7days", label: "7 days" },
  { value: "14days", label: "14 days" },
];

const DURATION_DAYS: Record<string, number> = {
  "1day": 1,
  "3days": 3,
  "7days": 7,
  "14days": 14,
};

const DURATION_LABELS: Record<string, string> = {
  "1day": "1 day",
  "3days": "3 days",
  "7days": "7 days",
  "14days": "14 days",
};

const FORMAT_PLACEHOLDER: Record<PollFormat, string> = {
  decision: "E.g. Which product feature should we prioritize?",
  prediction: "E.g. Who will win the match?",
  fan_vote: "E.g. Who was the best performer?",
  ranking: "E.g. Rank these options from best to worst",
  nomination: "E.g. Who should be nominated?",
  audience_choice: "E.g. What should happen next?",
};

const STEP_LABELS = ["decision", "support", "review"];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDecision(data: PollFormData): DecisionErrors {
  const errors: DecisionErrors = {};

  const trimmedQuestion = data.question.trim();

  if (!trimmedQuestion) {
    errors.question = "Question must be at least 10 characters.";
  } else if (trimmedQuestion.length < QUESTION_MIN_LENGTH) {
    errors.question = `Question must be at least ${QUESTION_MIN_LENGTH} characters.`;
  } else if (trimmedQuestion.length > QUESTION_MAX_LENGTH) {
    errors.question = `Question must be at most ${QUESTION_MAX_LENGTH} characters.`;
  }

  // Validate options
  const trimmedOptions = data.options.map((opt) => opt.trim());
  const nonEmptyCount = trimmedOptions.filter((opt) => opt.length > 0).length;

  if (nonEmptyCount < 2) {
    errors.options = "At least 2 options are required.";
  } else {
    // Check for duplicates (case-insensitive, trimmed)
    const normalized = trimmedOptions.map((opt) => opt.toLowerCase());
    const seen = new Set<string>();
    let hasDuplicate = false;
    for (const norm of normalized) {
      if (norm.length === 0) continue; // skip empty; already caught above
      if (seen.has(norm)) {
        hasDuplicate = true;
        break;
      }
      seen.add(norm);
    }
    if (hasDuplicate) {
      errors.options = "Options must be unique. Duplicates found.";
    }
  }

  return errors;
}

function validateSupport(data: PollFormData): SupportErrors {
  const errors: SupportErrors = {};

  if (!data.contributionMode) {
    errors.contributionMode = "Select a contribution mode.";
  }

  if (!data.purpose.trim()) {
    errors.purpose = "Describe what the NIM will support.";
  } else if (data.purpose.trim().length < PURPOSE_MIN_LENGTH) {
    errors.purpose = `Purpose must be at least ${PURPOSE_MIN_LENGTH} characters.`;
  }

  if (!data.destinationWallet.trim()) {
    errors.destinationWallet = "Enter a destination wallet address.";
  }

  const nimValue = Number(data.minimumNim);
  if (data.minimumNim.trim() === "" || isNaN(nimValue) || nimValue <= 0) {
    errors.minimumNim = "Minimum contribution must be greater than 0 NIM.";
  }

  if (!data.duration) {
    errors.duration = "Select a poll duration.";
  }

  return errors;
}

/**
 * Client-side (UX-only) reward validation. The server is authoritative.
 * Mirrors MIN_REWARD_PER_PARTICIPANT_LUNA = 1,000 Luna = 0.01 NIM.
 */
function validateReward(data: PollFormData): string | null {
  if (!data.rewardEnabled) return null;

  const result = validateRewardConfigInput({
    rewardPerParticipant: data.rewardPerParticipant.trim(),
    maxRewardedParticipants: Number(data.maxRewardedParticipants.trim()),
  });
  return result.ok ? null : result.errors[0] ?? "Invalid reward configuration.";
}

/** Derived display values from the shared reward domain (server remains authoritative). */
function computeRewardDisplay(data: PollFormData) {
  const empty = { principal: null as string | null, feeReserve: null as string | null, total: null as string | null };
  if (!data.rewardEnabled) return empty;

  const result = validateRewardConfigInput({
    rewardPerParticipant: data.rewardPerParticipant.trim(),
    maxRewardedParticipants: Number(data.maxRewardedParticipants.trim()),
  });
  if (!result.ok || !result.value) return empty;

  return {
    principal: formatNimAmount(result.value.rewardPrincipalLuna),
    feeReserve: formatNimAmount(result.value.feeReserveLuna),
    total: formatNimAmount(result.value.totalBudgetLuna),
  };
}

function hasSupportErrors(errors: SupportErrors): boolean {
  return Object.values(errors).some((v) => v !== undefined);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a per-option error message.
 * Returns undefined if valid, or a string describing the issue.
 */
function computeOptionError(
  options: string[],
  index: number,
): string | undefined {
  const value = options[index].trim();
  if (!value) return "Option cannot be empty.";

  const normalized = value.toLowerCase();
  const duplicateAt = options.findIndex(
    (opt, i) => i !== index && opt.trim().toLowerCase() === normalized,
  );
  if (duplicateAt !== -1) return "Duplicate option.";

  return undefined;
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function CreatePollPage() {
  const [step, setStep] = useState<number>(0);
  const [formData, setFormData] = useState<PollFormData>(INITIAL_FORM_DATA);
  const [showErrors, setShowErrors] = useState<boolean>(false);
  const { walletStatus, activeAccount } = useNimiqContext();
  const {
    status: sessionStatus,
    error: sessionError,
    verifyActiveWallet,
    isSessionVerified,
    isWalletMatched,
  } = useVotumSession();
  const { openOnboarding } = useOnboarding();
  const pathname = usePathname();

  // ---- Publication state ----
  type PublishState = "idle" | "preparing" | "publishing" | "success" | "error";
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [publishError, setPublishError] = useState<string | null>(null);
  const [publishedPollId, setPublishedPollId] = useState<string | null>(null);
  const router = useRouter();
  void publishedPollId; // consumed by the redirect side-effect

  // ---- Draft loading ----
  const searchParams = useSearchParams();
  const draftIdParam = searchParams.get("draft");
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [initialDraftId] = useState(draftIdParam);

  useEffect(() => {
    if (!initialDraftId || draftLoaded) return;
    const existing = getDraft(initialDraftId);
    if (existing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring draft on mount
      setFormData({
        category: existing.category,
        format: existing.format,
        question: existing.question,
        context: existing.context,
        options:
          existing.options.length >= 2
            ? existing.options
            : [...existing.options, ""],
        contributionMode: existing.contributionMode,
        purpose: existing.purpose,
        destinationWallet: existing.destinationWallet,
        minimumNim: existing.minimumNim,
        duration: existing.duration,
        rewardEnabled: existing.reward?.enabled ?? false,
        rewardPerParticipant: existing.reward?.rewardPerParticipant ?? "",
        maxRewardedParticipants: existing.reward?.maxRewardedParticipants ?? "",
      });
      const stepIndex = ["decision", "support", "review"].indexOf(
        existing.currentStep,
      );
      if (stepIndex >= 0) setStep(stepIndex);
    }
    setDraftLoaded(true);
  }, [initialDraftId, draftLoaded]);

  // ---- Draft autosave ----
  const { draft, setDraftStatus, saveImmediately } = usePollDraft({
    draftId: initialDraftId,
    formData: {
      question: formData.question,
      context: formData.context,
      options: formData.options,
      contributionMode: formData.contributionMode,
      destinationWallet: formData.destinationWallet,
      purpose: formData.purpose,
      minimumNim: formData.minimumNim,
      duration: formData.duration,
      reward: {
        enabled: formData.rewardEnabled,
        rewardPerParticipant: formData.rewardPerParticipant,
        maxRewardedParticipants: formData.maxRewardedParticipants,
      },
    },
    currentStep: (["decision", "support", "review"] as const)[step],
  });

  // Update draft status based on wallet / session state during review
  useEffect(() => {
    if (step !== 2) return;
    if (!walletStatus || walletStatus !== "connected") {
      if (isSessionVerified) {
        // Don't downgrade — session is verified, just wallet is disconnected
        setDraftStatus("awaiting_wallet");
      } else {
        setDraftStatus("awaiting_wallet");
      }
    } else if (!isSessionVerified) {
      setDraftStatus("awaiting_verification");
    } else if (isSessionVerified) {
      setDraftStatus("ready_to_publish");
    }
  }, [step, walletStatus, isSessionVerified, setDraftStatus]);

  // ---- Derived validation ----
  const decisionErrors = useMemo(
    () => validateDecision(formData),
    [formData],
  );
  const supportErrors = useMemo(() => validateSupport(formData), [formData]);
  const rewardError = useMemo(() => validateReward(formData), [formData]);
  const rewardDisplay = useMemo(() => computeRewardDisplay(formData), [formData]);

  // ---- Per-option errors (only shown when showErrors is true) ----
  const optionErrors = useMemo(() => {
    if (!showErrors)
      return Array<undefined>(formData.options.length).fill(undefined);
    return formData.options.map((_, i) =>
      computeOptionError(formData.options, i),
    );
  }, [formData.options, showErrors]);

  // ---- Computed closing time ----
  const closingTime = useMemo(() => {
    const days = DURATION_DAYS[formData.duration];
    if (!days) return null;
    const now = new Date();
    const closeDate = new Date(now);
    closeDate.setDate(closeDate.getDate() + days);
    return closeDate;
  }, [formData.duration]);

  // ---- Publishing eligibility ----
  // Wallet/session verification is NOT a hard gate here: an unverified user
  // tapping Publish opens onboarding with the create_poll intent instead,
  // keeping their form state intact. Authorization is still enforced
  // server-side by the publish route's verified-session check.
  const canPublish = useMemo(() => {
    if (publishState !== "idle" && publishState !== "error") return false;
    if (!draft) return false;
    // Form must be valid (question non-empty, options >= 2)
    if (!formData.question.trim() || formData.options.filter(o => o.trim()).length < 2) return false;
    // Reward config must be valid when enabled (UX gate; server authoritative)
    if (formData.rewardEnabled && rewardError) return false;
    return true;
  }, [publishState, draft, formData, rewardError]);

  // ---- Publish handler ----
  const handlePublish = useCallback(async () => {
    // Gate: unverified → onboarding with the create intent; form state
    // (including the persisted draft) is preserved for the return.
    if (!isSessionVerified || !isWalletMatched) {
      openOnboarding({ intent: "create_poll", returnPath: pathname });
      return;
    }

    setPublishState("preparing");
    setPublishError(null);

    // Stage 1: Ensure publication key
    let idKey: string;
    try {
      idKey = ensurePublicationKey(draft!.id);
    } catch {
      setPublishError("Votum could not prepare this draft for publication. Your draft is still safe.");
      setPublishState("error");
      return;
    }

    // Stage 2: Serialize request
    const body: Record<string, unknown> = {
      category: formData.category,
      format: formData.format,
      question: formData.question,
      description: formData.context || null,
      options: formData.options.filter(o => o.trim()),
      mode: formData.contributionMode,
      destinationWallet: formData.destinationWallet,
      destinationPurpose: formData.purpose,
      minimumNim: formData.minimumNim,
      fairnessMode: "one_wallet_one_vote",
      duration: formData.duration,
      idempotencyKey: idKey,
    };

    if (formData.rewardEnabled) {
      body.reward = {
        rewardPerParticipant: formData.rewardPerParticipant,
        maxRewardedParticipants: Number(formData.maxRewardedParticipants),
      };
    }

    let bodyJson: string;
    try {
      bodyJson = JSON.stringify(body);
    } catch {
      setPublishError("Votum could not prepare the publication request. Your draft is still safe.");
      setPublishState("error");
      return;
    }

    setPublishState("publishing");

    // Stage 3: Send request
    let res: Response;
    try {
      res = await fetch("/api/polls/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson,
        credentials: "same-origin",
      });
    } catch {
      setPublishError("Votum could not reach the publishing service. Your draft is still safe. Try again.");
      setPublishState("error");
      return;
    }

    // Stage 4: Parse response
    const data = await res.json().catch(() => ({}));

    if (res.ok) {
      const pollId = data.poll?.id;
      if (!pollId) {
        setPublishError("Votum received an unexpected publishing response. Your draft is still safe.");
        setPublishState("error");
        return;
      }
      setPublishedPollId(pollId);
      setPublishState("success");
      try { deleteDraft(draft!.id); } catch { /* non-critical */ }
      setTimeout(() => {
        router.replace(`/polls/${pollId}?published=1`);
      }, 1000);
      return;
    }
    // Structured errors
    const errorCode = data.error as string;
    const message = data.message as string || "";

    if (res.status === 401) {
      setPublishError("Your verified wallet session has expired. Verify your wallet again to publish this poll.");
    } else if (res.status === 409) {
      setPublishError("This draft may already have been published before it was edited.");
    } else if (errorCode === "validation_failed") {
      setPublishError("Some poll details need attention before publishing. Please review and try again.");
    } else {
      setPublishError(message || "Votum could not publish this poll. Your draft is still safe.");
    }
    setPublishState("error");
  }, [draft, formData, router, isSessionVerified, isWalletMatched, openOnboarding, pathname]);

  // ---- Field updaters ----
  function updateField<K extends keyof PollFormData>(
    key: K,
    value: PollFormData[K],
  ) {
    setFormData((prev) => ({ ...prev, [key]: value }));
  }

  function handleOptionsChange(newOptions: string[]) {
    setFormData((prev) => ({ ...prev, options: newOptions }));
  }

  // ---- Step navigation ----
  function goToStep(nextStep: number) {
    setShowErrors(false);
    setStep(nextStep);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function handleContinueFromDecision() {
    const errors = validateDecision(formData);
    if (errors.question || errors.options) {
      setShowErrors(true);
      return;
    }
    goToStep(1);
  }

  function handleContinueFromSupport() {
    const errors = validateSupport(formData);
    if (hasSupportErrors(errors)) {
      setShowErrors(true);
      return;
    }
    if (formData.rewardEnabled && validateReward(formData)) {
      setShowErrors(true);
      return;
    }
    goToStep(2);
  }

  // ---- Shared class strings ----
  const sectionSpacing = "flex flex-col gap-5";

  // ---- Derived display values ----
  const closingTimeStr = closingTime
    ? formatClosingTime(closingTime)
    : null;
  const durationLabel =
    DURATION_LABELS[formData.duration] ?? formData.duration;

  // ---- Create gate ----
  // The create form is usable only for a verified, matched session. A
  // disconnected or connected-but-unverified visitor gets the shared
  // onboarding gate instead (intent=create_poll) so they can connect/verify
  // and return to /create. Verification remains explicit — never auto-signed.
  const canCreate = isSessionVerified && isWalletMatched;

  // =========================================================================
  // RENDER
  // =========================================================================

  return (
    <ProductShell>
      {!canCreate ? (
        <CreateGate />
      ) : (
      <>
      {/* ================================================================= */}
      {/* STEPPER                                                           */}
      {/* ================================================================= */}
      <Card glass className="mb-6 p-5">
        <ProofPath
          steps={STEP_LABELS}
          activeStep={step}
          className="mb-1"
        />

        <div className="flex items-center justify-between mb-4">
          <p className="text-secondary text-quiet-ink">
            Step {step + 1} of 3
          </p>
          {draft && (
            <div className="flex items-center gap-3">
              <span className="text-micro text-verified-green">
                Draft saved
              </span>
              <Link
                href="/drafts"
                onClick={saveImmediately}
                className="text-sm text-quiet-ink hover:text-ballot-ink transition-colors"
              >
                Save and exit
              </Link>
            </div>
          )}
        </div>
        <h1 className="font-display text-page-title text-ballot-ink">
          Build a Votum Poll.
        </h1>
        <p className="mt-2 text-body text-quiet-ink">
          Choose the category, define the participation, disclose the NIM
          support destination, then review before publishing.
        </p>
      </Card>

      <Card glass className="p-5 sm:p-7">

      {/* ================================================================= */}
      {/* STEP 0 — DECISION                                                 */}
      {/* ================================================================= */}
      {step === 0 && (
        <div className={sectionSpacing}>
          {/* ---- Category ---- */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ballot-ink">
              What is this poll about?
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {POLL_CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  role="radio"
                  aria-checked={formData.category === cat}
                  tabIndex={formData.category === cat ? 0 : -1}
                  onClick={() => updateField("category", cat)}
                  className={`px-3 py-2 text-sm font-medium rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                    formData.category === cat
                      ? "bg-signal-gold/10 border-signal-gold text-ballot-ink"
                      : "bg-soft-fog border-border text-quiet-ink hover:border-quiet-ink"
                  }`}
                >
                  {CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* ---- Format ---- */}
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-ballot-ink">
              What kind of participation is this?
            </legend>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {POLL_FORMATS.map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  role="radio"
                  aria-checked={formData.format === fmt}
                  tabIndex={formData.format === fmt ? 0 : -1}
                  onClick={() => updateField("format", fmt)}
                  className={`px-3 py-2 text-sm font-medium rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                    formData.format === fmt
                      ? "bg-signal-gold/10 border-signal-gold text-ballot-ink"
                      : "bg-soft-fog border-border text-quiet-ink hover:border-quiet-ink"
                  }`}
                >
                  {FORMAT_LABELS[fmt]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* ---- Question ---- */}
          <div className="flex flex-col gap-1.5">
            <Input
              label="What is your poll asking?"
              hint="Keep it specific enough that participants can understand the choice immediately."
              placeholder={FORMAT_PLACEHOLDER[formData.format]}
              value={formData.question}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("question", e.target.value)
              }
              error={showErrors ? decisionErrors.question : undefined}
              maxLength={QUESTION_MAX_LENGTH}
            />
            <p className="text-micro text-right text-quiet-ink">
              {formData.question.length}/{QUESTION_MAX_LENGTH}
            </p>
          </div>

          {/* ---- Context (optional) ---- */}
          <Textarea
            label="Add context"
            hint="Help participants understand why this decision matters."
            placeholder="Provide background information, links, or reasoning that helps participants understand the choice."
            value={formData.context}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              updateField("context", e.target.value)
            }
          />

          {/* ---- Poll Options ---- */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-ballot-ink">
              Poll options
            </label>
            {showErrors && decisionErrors.options && (
              <p
                className="text-micro text-reject-red"
                role="alert"
              >
                {decisionErrors.options}
              </p>
            )}

            <PollOptionsEditor
              options={formData.options}
              onChange={handleOptionsChange}
              errors={optionErrors}
            />
          </div>

          {/* ---- Navigation ---- */}
          <div className="pt-2">
            <Button
              type="button"
              variant="primary"
              onClick={handleContinueFromDecision}
            >
              Continue to support details
            </Button>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* STEP 1 — SUPPORT                                                  */}
      {/* ================================================================= */}
      {step === 1 && (
        <div className={sectionSpacing}>
          {/* ---- Contribution Mode ---- */}
          <ContributionModeSelector
            value={formData.contributionMode}
            onChange={(mode) => updateField("contributionMode", mode)}
            error={
              showErrors ? supportErrors.contributionMode : undefined
            }
          />

          {/* ---- Contribution Purpose ---- */}
          <Textarea
            label="What will the NIM support?"
            hint="This statement will be shown before someone confirms their contribution. Describe how the contribution supports this creator, project or community."
            placeholder="E.g. Funds go toward materials and artist stipends for the Main Street mural project."
            value={formData.purpose}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
              updateField("purpose", e.target.value)
            }
            error={showErrors ? supportErrors.purpose : undefined}
          />

          {/* ---- Destination Wallet ---- */}
          <div className="flex flex-col gap-1.5">
            <Input
              label="Contribution destination"
              hint="Participants will see this wallet before confirming their NIM contribution."
              placeholder="NQ... or 0x..."
              value={formData.destinationWallet}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("destinationWallet", e.target.value)
              }
              error={showErrors ? supportErrors.destinationWallet : undefined}
            />
            {activeAccount && (
              <button
                type="button"
                onClick={() =>
                  updateField("destinationWallet", activeAccount)
                }
                className="text-sm text-nim-blue hover:text-signal-gold transition-colors font-medium focus-visible:outline-none focus-visible:underline"
              >
                Use connected wallet: {truncateAddress(activeAccount)}
              </button>
            )}
            {activeAccount ? (
              <p className="text-micro text-quiet-ink">
                Your wallet is connected. Use the connected address above or
                enter a different destination.
              </p>
            ) : (
              <p className="text-micro text-quiet-ink">
                Connect your wallet to use your address as the contribution
                destination, or enter one manually.
              </p>
            )}
          </div>

          {/* ---- Minimum NIM Contribution ---- */}
          <div className="flex flex-col gap-1.5">
            <Input
              label="Minimum contribution"
              hint="Each verified vote must meet this minimum contribution."
              type="number"
              min="0.001"
              step="0.001"
              placeholder="0.001"
              value={formData.minimumNim}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("minimumNim", e.target.value)
              }
              error={showErrors ? supportErrors.minimumNim : undefined}
            />
            <p className="text-micro text-quiet-ink">NIM</p>
          </div>

          {/* ---- Poll Duration ---- */}
          <div className="flex flex-col gap-1.5">
            <Select
              label="Poll duration"
              options={DURATION_OPTIONS}
              placeholder="Select duration"
              value={formData.duration}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                updateField("duration", e.target.value)
              }
              error={showErrors ? supportErrors.duration : undefined}
            />
            {closingTime && (
              <p className="text-secondary text-quiet-ink">
                Planned closing time: {formatClosingTime(closingTime)}
              </p>
            )}
          </div>

          {/* ---- Fairness Rule ---- */}
          <div className="flex flex-col gap-2 pt-1">
            <FairnessLabel />
            <p className="text-secondary text-quiet-ink">
              Every eligible wallet records one vote. The NIM contribution is
              shown as a separate support signal. Contributing more NIM does
              not create additional votes.
            </p>
          </div>

          {/* ---- Optional Reward (V2B.2.3) ---- */}
          <div className="flex flex-col gap-3 pt-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ballot-ink">
                  Reward participants with NIM
                </p>
                <p className="text-micro text-quiet-ink">
                  Optional. Rewards are for participating — never for choosing a
                  particular option.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={formData.rewardEnabled}
                onClick={() => updateField("rewardEnabled", !formData.rewardEnabled)}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal-gold ${
                  formData.rewardEnabled ? "bg-signal-gold" : "bg-border"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    formData.rewardEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {formData.rewardEnabled && (
              <div className="flex flex-col gap-3 rounded-lg border border-border bg-soft-fog/40 p-3">
                <p className="text-secondary text-quiet-ink">
                  Participants earn for participating, regardless of which option
                  they choose.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Input
                      label="Reward per participant"
                      hint="Each eligible participant receives this exact amount."
                      type="text"
                      inputMode="decimal"
                      placeholder="0.01"
                      value={formData.rewardPerParticipant}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        updateField("rewardPerParticipant", e.target.value)
                      }
                    />
                    <p className="text-micro text-quiet-ink">NIM</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Input
                      label="Maximum rewarded participants"
                      hint="Rewards stop once this many participants have earned."
                      type="text"
                      inputMode="numeric"
                      placeholder="100"
                      value={formData.maxRewardedParticipants}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        updateField("maxRewardedParticipants", e.target.value)
                      }
                    />
                  </div>
                </div>

                {rewardError && (
                  <p
                    className="text-micro text-reject-red"
                    role="alert"
                  >
                    {rewardError}
                  </p>
                )}

                {!rewardError && rewardDisplay.total && (
                  <dl className="flex flex-col gap-1 text-secondary text-quiet-ink">
                    <div className="flex items-center justify-between">
                      <dt className="text-micro">Reward principal</dt>
                      <dd className="text-micro font-medium">{rewardDisplay.principal}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="text-micro">Estimated fee reserve</dt>
                      <dd className="text-micro font-medium">{rewardDisplay.feeReserve}</dd>
                    </div>
                    <div className="flex items-center justify-between border-t border-divider pt-1">
                      <dt className="text-sm font-medium">Total required funding</dt>
                      <dd className="text-sm font-medium">{rewardDisplay.total}</dd>
                    </div>
                  </dl>
                )}

                <p className="text-micro text-quiet-ink">
                  You will fund this reward budget before the poll can be
                  advertised as rewarded.
                </p>
              </div>
            )}
          </div>

          {/* ---- Navigation ---- */}
          <div className="flex items-center justify-between gap-3 pt-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => goToStep(0)}
            >
              Back to decision
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleContinueFromSupport}
            >
              Review Votum Poll
            </Button>
          </div>
        </div>
      )}

      {/* ================================================================= */}
      {/* STEP 2 — REVIEW                                                   */}
      {/* ================================================================= */}
      {step === 2 && (
        <>
          <PollReview
            category={formData.category}
            format={formData.format}
            question={formData.question}
            context={formData.context}
            options={formData.options}
            contributionMode={formData.contributionMode}
            purpose={formData.purpose}
            destinationWallet={formData.destinationWallet}
            minimumNim={formData.minimumNim}
            duration={formData.duration}
            durationLabel={durationLabel}
            closingTime={closingTimeStr}
            onEditDecision={() => goToStep(0)}
            onEditSupport={() => goToStep(1)}
            activeAccount={activeAccount}
            walletStatus={walletStatus}
            sessionStatus={sessionStatus}
            sessionError={sessionError}
            onVerifyActiveWallet={verifyActiveWallet}
            canPublish={canPublish}
            publishState={publishState}
            publishError={publishError}
            onPublish={handlePublish}
          />
          <div className="pt-2">
            <Link
              href="/drafts"
              onClick={saveImmediately}
              className="text-sm text-quiet-ink hover:text-ballot-ink transition-colors"
            >
              Back to drafts
            </Link>
          </div>
        </>
      )}
      </Card>
      </>
      )}
    </ProductShell>
  );
}
