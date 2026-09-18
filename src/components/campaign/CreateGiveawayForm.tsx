"use client";

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { CreateGate } from "@/components/creator/CreateGate";
import { createCampaign } from "@/lib/campaigns/creator-client";
import { useVotumSession } from "@/providers/VotumSessionProvider";

const GIVEAWAY_TYPE = "public_giveaway";
const FUNDING_MODE = "creator";

const VISIBILITY_OPTIONS = [
  { value: "public", label: "Public" },
  { value: "unlisted", label: "Unlisted" },
  { value: "private", label: "Private" },
] as const;

type Visibility = (typeof VISIBILITY_OPTIONS)[number]["value"];

export interface GiveawayFormValues {
  title: string;
  description: string;
  rewardPerParticipant: string;
  maxRewardedParticipants: string;
  startsAt: string;
  endsAt: string;
  visibility: Visibility;
}

export type GiveawayFormErrors = Partial<
  Record<keyof GiveawayFormValues | "form", string>
>;

/**
 * Client-side (UX-only) validation. The Campaign configuration route is the
 * final authority; this mirrors only the inexpensive checks (required title,
 * positive reward/capacity, window ordering) in existing Votum form style.
 */
export function validateGiveawayForm(values: GiveawayFormValues): GiveawayFormErrors {
  const errors: GiveawayFormErrors = {};

  const title = values.title.trim();
  if (title.length < 1 || title.length > 160) {
    errors.title = "Enter a title between 1 and 160 characters.";
  }

  const rewardRaw = values.rewardPerParticipant.trim();
  const reward = Number(rewardRaw);
  if (rewardRaw.length === 0 || !Number.isFinite(reward) || reward <= 0) {
    errors.rewardPerParticipant = "Enter a reward amount greater than 0 NIM.";
  }

  const capacityRaw = values.maxRewardedParticipants.trim();
  const capacity = /^\d+$/.test(capacityRaw) ? Number(capacityRaw) : Number.NaN;
  if (
    capacityRaw.length === 0 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 1
  ) {
    errors.maxRewardedParticipants =
      "Enter a whole number of participants (1 or more).";
  }

  if (
    values.visibility !== "public" &&
    values.visibility !== "unlisted" &&
    values.visibility !== "private"
  ) {
    errors.visibility = "Choose public, unlisted, or private visibility.";
  }

  let starts: number | null = null;
  let ends: number | null = null;
  if (values.startsAt) {
    starts = new Date(values.startsAt).getTime();
    if (!Number.isFinite(starts)) {
      errors.startsAt = "Enter a valid start date and time.";
      starts = null;
    }
  }
  if (values.endsAt) {
    ends = new Date(values.endsAt).getTime();
    if (!Number.isFinite(ends)) {
      errors.endsAt = "Enter a valid end date and time.";
      ends = null;
    }
  }
  if (starts !== null && ends !== null && ends <= starts) {
    errors.endsAt = "End must be after the start.";
  }

  return errors;
}

function toIsoOrNull(localValue: string): string | null {
  if (!localValue) return null;
  const time = new Date(localValue).getTime();
  if (!Number.isFinite(time)) return null;
  return new Date(localValue).toISOString();
}

function readCampaignId(campaign: unknown): string | null {
  if (typeof campaign !== "object" || campaign === null) return null;
  const record = campaign as Record<string, unknown>;
  for (const key of ["campaignId", "id"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

const INITIAL_VALUES: GiveawayFormValues = {
  title: "",
  description: "",
  rewardPerParticipant: "",
  maxRewardedParticipants: "",
  startsAt: "",
  endsAt: "",
  visibility: "public",
};

function GiveawayForm() {
  const router = useRouter();
  const [values, setValues] = useState<GiveawayFormValues>(INITIAL_VALUES);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const errors = useMemo(() => validateGiveawayForm(values), [values]);
  const hasErrors = Object.keys(errors).length > 0;
  const summaryReady =
    !errors.title &&
    !errors.rewardPerParticipant &&
    !errors.maxRewardedParticipants &&
    values.title.trim().length > 0 &&
    values.rewardPerParticipant.trim().length > 0 &&
    values.maxRewardedParticipants.trim().length > 0;

  function updateField<Key extends keyof GiveawayFormValues>(
    key: Key,
    value: GiveawayFormValues[Key],
  ) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setServerError(null);
    const currentErrors = validateGiveawayForm(values);
    if (Object.keys(currentErrors).length > 0) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setSubmitting(true);
    try {
      const result = await createCampaign({
        type: GIVEAWAY_TYPE,
        title: values.title.trim(),
        description: values.description.trim()
          ? values.description.trim()
          : null,
        visibility: values.visibility,
        startsAt: toIsoOrNull(values.startsAt),
        endsAt: toIsoOrNull(values.endsAt),
        rewardPerParticipant: values.rewardPerParticipant.trim(),
        maxRewardedParticipants: Number(
          values.maxRewardedParticipants.trim(),
        ),
        fundingMode: FUNDING_MODE,
      });
      if (result.kind === "error") {
        const detail = result.error.message
          ? ` ${result.error.message}`
          : " Check the highlighted fields and try again.";
        setServerError(
          `Could not create giveaway (${result.error.code}).${detail}`,
        );
        return;
      }
      const campaignId = readCampaignId(result.campaign);
      if (!campaignId) {
        setServerError(
          "Votum could not read the created giveaway. It may exist — check back shortly.",
        );
        return;
      }
      router.push(`/campaigns/${campaignId}/manage`);
    } catch {
      setServerError(
        "Votum could not reach the campaign service. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card glass className="p-5 sm:p-7">
      <h1 className="font-display text-page-title text-ballot-ink">
        Create a Public Giveaway.
      </h1>
      <p className="mt-2 text-body text-quiet-ink">
        Offer a fixed NIM reward for verified participation. Create your
        giveaway as a draft. Next, publish it, then fund the reward budget
        from the management page.
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-6 flex flex-col gap-5">
        <Input
          label="Giveaway title"
          hint="Shown to participants exploring rewards."
          placeholder="E.g. Neighborhood cleanup reward"
          value={values.title}
          maxLength={160}
          onChange={(e: ChangeEvent<HTMLInputElement>) =>
            updateField("title", e.target.value)
          }
          error={showErrors ? errors.title : undefined}
          disabled={submitting}
          required
        />

        <Textarea
          label="Description"
          hint="Optional. Help participants understand what this giveaway is for."
          placeholder="What is this giveaway rewarding?"
          value={values.description}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
            updateField("description", e.target.value)
          }
          error={showErrors ? errors.description : undefined}
          disabled={submitting}
        />

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Input
              label="Reward per participant"
              hint="Each eligible participant receives this exact amount."
              type="text"
              inputMode="decimal"
              placeholder="0.5"
              value={values.rewardPerParticipant}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                updateField("rewardPerParticipant", e.target.value)
              }
              error={showErrors ? errors.rewardPerParticipant : undefined}
              disabled={submitting}
              required
            />
            <p className="text-micro text-quiet-ink">NIM</p>
          </div>
          <Input
            label="Maximum rewarded participants"
            hint="Rewards stop once this many participants have earned."
            type="text"
            inputMode="numeric"
            placeholder="10"
            value={values.maxRewardedParticipants}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              updateField("maxRewardedParticipants", e.target.value)
            }
            error={showErrors ? errors.maxRewardedParticipants : undefined}
            disabled={submitting}
            required
          />
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Input
            label="Starts at"
            hint="Optional. Leave empty to keep the giveaway untimed at first."
            type="datetime-local"
            value={values.startsAt}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              updateField("startsAt", e.target.value)
            }
            error={showErrors ? errors.startsAt : undefined}
            disabled={submitting}
          />
          <Input
            label="Ends at"
            hint="Optional. Must be after the start when both are set."
            type="datetime-local"
            value={values.endsAt}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              updateField("endsAt", e.target.value)
            }
            error={showErrors ? errors.endsAt : undefined}
            disabled={submitting}
          />
        </div>

        <Select
          label="Visibility"
          hint="Public giveaways are discoverable by everyone."
          options={VISIBILITY_OPTIONS.map((option) => ({ ...option }))}
          value={values.visibility}
          onChange={(e: ChangeEvent<HTMLSelectElement>) =>
            updateField("visibility", e.target.value as Visibility)
          }
          error={showErrors ? errors.visibility : undefined}
          disabled={submitting}
        />

        {summaryReady && (
          <dl
            className="flex flex-col gap-1 rounded-overlay border border-border bg-soft-fog/40 px-4 py-3 text-secondary text-quiet-ink"
            aria-label="Giveaway summary"
          >
            <div className="flex items-center justify-between gap-3">
              <dt className="text-micro">Reward</dt>
              <dd className="text-micro font-medium text-ballot-ink">
                {values.rewardPerParticipant.trim()} NIM each
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-micro">Participant cap</dt>
              <dd className="text-micro font-medium text-ballot-ink">
                Up to {values.maxRewardedParticipants.trim()}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-micro">Visibility</dt>
              <dd className="text-micro font-medium text-ballot-ink">
                {values.visibility}
              </dd>
            </div>
          </dl>
        )}

        {serverError && (
          <p className="text-micro text-reject-red" role="alert">
            {serverError}
          </p>
        )}

        <div className="pt-1">
          <Button
            type="submit"
            variant="primary"
            disabled={submitting || (showErrors && hasErrors)}
          >
            {submitting ? "Creating..." : "Create giveaway"}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Creator-gated entry for Public Giveaway creation. Verified, matched
 * sessions see the form; everyone else gets the shared create onboarding
 * gate (intent=create_poll). Verification is never auto-signed.
 */
export function CreateGiveawayForm() {
  const { isSessionVerified, isWalletMatched } = useVotumSession();

  if (!isSessionVerified || !isWalletMatched) {
    return <CreateGate />;
  }
  return <GiveawayForm />;
}
