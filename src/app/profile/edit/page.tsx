"use client";

import { useEffect, useState } from "react";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { LoadingState } from "@/components/state/LoadingState";
import { ErrorState } from "@/components/state/ErrorState";
import { WalletRequiredState } from "@/components/state/WalletRequiredState";
import { ProfileEditForm } from "@/components/profile/ProfileEditForm";
import { useOnboarding } from "@/providers/OnboardingProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { usePathname } from "next/navigation";
import type { ParticipantProfile } from "@/lib/profiles/types";

/**
 * /profile/edit — owner-only profile editing.
 *
 * The page never asks the client which wallet to edit: the session decides
 * (GET /api/profile/me is scoped to the verified session wallet). Without a
 * verified, wallet-matched session the form is never rendered — the user is
 * routed into the shared onboarding flow instead.
 */
export default function ProfileEditPage() {
  const { status: sessionStatus, isSessionVerified, isWalletMatched } =
    useVotumSession();
  const { openOnboarding } = useOnboarding();
  const pathname = usePathname();

  const [profile, setProfile] = useState<ParticipantProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fetchNonce, setFetchNonce] = useState(0);

  const canEdit = sessionStatus !== "loading" && isSessionVerified && isWalletMatched;

  useEffect(() => {
    if (!canEdit) return;
    let cancelled = false;
    void (async () => {
      try {
        let res = await fetch("/api/profile/me");
        if (res.status === 404) {
          // Edge: verified wallet without a profile row — bootstrap once, then
          // retry. Regular flow always bootstraps on verification.
          await fetch("/api/profile/bootstrap", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          res = await fetch("/api/profile/me");
        }
        if (cancelled) return;
        if (!res.ok) {
          setLoadError("Votum could not load your profile. Try again.");
          return;
        }
        const data = (await res.json()) as { profile?: ParticipantProfile };
        if (cancelled) return;
        if (!data?.profile) {
          setLoadError("Votum could not load your profile. Try again.");
          return;
        }
        setProfile(data.profile);
        setLoadError(null);
      } catch {
        if (!cancelled) {
          setLoadError("Votum could not reach the server. Try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canEdit, fetchNonce]);

  // ---- Session not resolved yet ----
  if (sessionStatus === "loading") {
    return (
      <ProductShell>
        <LoadingState variant="page" className="mx-auto w-full max-w-md" />
      </ProductShell>
    );
  }

  // ---- No verified, wallet-matched session: gate, never the form ----
  if (!canEdit) {
    return (
      <ProductShell>
        <WalletRequiredState
          title="Verify your wallet to edit your profile"
          description="Only the verified owner of a profile can change its display name or handle. Connect and verify your Nimiq wallet to continue."
          className="mt-4"
        />
        <div className="mx-auto mt-4 flex w-full max-w-md justify-center">
          <Button
            type="button"
            variant="primary"
            onClick={() =>
              openOnboarding({ intent: "generic_connect", returnPath: pathname })
            }
          >
            Verify to edit your profile
          </Button>
        </div>
      </ProductShell>
    );
  }

  // ---- Owner profile loading / error / ready ----
  if (profile) {
    return (
      <ProductShell>
        <div className="mx-auto w-full max-w-md">
          <Card glass className="p-5 sm:p-7">
            <h1 className="font-display text-page-title text-ballot-ink">
              Edit profile
            </h1>
            <p className="mt-2 text-body text-quiet-ink">
              {"Your profile is public. Only your display name and handle are editable \u2014 your wallet identity stays canonical."}
            </p>
            <div className="mt-6">
              <ProfileEditForm initialProfile={profile} />
            </div>
          </Card>
        </div>
      </ProductShell>
    );
  }

  if (loadError) {
    return (
      <ProductShell>
        <ErrorState
          title="Profile unavailable"
          description={loadError}
          onRetry={() => {
            setLoadError(null);
            setFetchNonce((n) => n + 1);
          }}
          className="mt-4"
        />
      </ProductShell>
    );
  }

  return (
    <ProductShell>
      <LoadingState variant="page" className="mx-auto w-full max-w-md" />
    </ProductShell>
  );
}
