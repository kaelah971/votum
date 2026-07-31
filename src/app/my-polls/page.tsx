"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ProductShell } from "@/components/layout/ProductShell";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/state/EmptyState";
import { ErrorState } from "@/components/state/ErrorState";
import { LoadingState } from "@/components/state/LoadingState";
import { WalletButton } from "@/components/ui/WalletButton";
import { WalletIconLarge } from "@/components/ui/icons";
import { useVotumSession } from "@/providers/VotumSessionProvider";
import { useNimiqContext } from "@/providers/NimiqProvider";

interface CreatorPoll {
  id: string;
  question: string;
  status: string;
  isPublic: boolean;
  createdAt: string;
  optionCount: number;
}

export default function MyPollsPage() {
  const { isSessionVerified, verifyActiveWallet } = useVotumSession();
  const { walletStatus, isInsideNimiqPay } = useNimiqContext();
  const [polls, setPolls] = useState<CreatorPoll[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPolls = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/me/polls", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 401) {
        setPolls(null);
        setError(null);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError("Your polls could not be loaded.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setPolls(data.polls ?? []);
      setError(null);
    } catch {
      setError("Your polls could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPolls();
  }, [fetchPolls]);

  // Re-fetch when session becomes verified
  useEffect(() => {
    if (isSessionVerified) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchPolls();
    }
  }, [isSessionVerified, fetchPolls]);

  const headerCard = (
    <Card glass className="mb-6 p-6">
      <p className="text-micro text-quiet-ink tracking-wider">CREATOR POLLS</p>
      <h1 className="mt-3 font-display text-page-title text-ballot-ink">
        Your Votum Polls.
      </h1>
    </Card>
  );

  // State: Loading
  if (loading) {
    return (
      <ProductShell>
        {headerCard}
        <LoadingState variant="list" count={4} />
      </ProductShell>
    );
  }

  // State: No verified session
  if (polls === null && !error) {
    // Check if wallet is connected but unverified
    if (walletStatus === "connected") {
      return (
        <ProductShell>
          {headerCard}
          <Card glass className="flex flex-col items-center p-6">
            <div className="flex w-full max-w-md flex-col items-center justify-center px-5 py-16 text-center">
              <div className="mb-6 text-signal-gold opacity-80">
                <WalletIconLarge />
              </div>
              <h2 className="text-section-heading font-display text-ballot-ink text-center">
                Verify wallet ownership
              </h2>
              <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
                Verify your wallet to view polls you have created.
              </p>
              <div className="mt-8">
                <Button type="button" variant="primary" onClick={verifyActiveWallet}>
                  Verify wallet ownership
                </Button>
              </div>
            </div>
          </Card>
        </ProductShell>
      );
    }

    return (
      <ProductShell>
        {headerCard}
        <Card glass className="flex flex-col items-center p-6">
          <div className="flex w-full max-w-md flex-col items-center justify-center px-5 py-16 text-center">
            <div className="mb-6 text-signal-gold opacity-80">
              <WalletIconLarge />
            </div>
            <h2 className="text-section-heading font-display text-ballot-ink text-center">
              Verify your wallet
            </h2>
            <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
              Verify your wallet ownership to view polls you have created.
            </p>
            {!isInsideNimiqPay && (
              <p className="text-secondary text-quiet-ink text-center mt-2">
                Open Votum in Nimiq Pay to connect your wallet.
              </p>
            )}
            <div className="mt-8">
              <WalletButton />
            </div>
          </div>
        </Card>
      </ProductShell>
    );
  }

  // State: Error
  if (error) {
    return (
      <ProductShell>
        {headerCard}
        <ErrorState
          title={error}
          description="Try refreshing the page."
        />
      </ProductShell>
    );
  }

  // State: Empty
  if (polls && polls.length === 0) {
    return (
      <ProductShell>
        {headerCard}
        <EmptyState
          title="You have not published a poll yet."
          description="Create a Votum Poll and publish it to see it here."
          action={
            <Link
              href="/create"
              className="inline-flex items-center justify-center rounded-full bg-signal-gold text-ballot-ink hover:bg-deep-gold font-medium transition-colors px-6 py-3 text-sm"
            >
              Create a Votum Poll
            </Link>
          }
        />
      </ProductShell>
    );
  }

  // State: Polls loaded (guaranteed non-null with items from flow above)
  const safePolls = polls ?? [];

  return (
    <ProductShell>
      {headerCard}

      <p className="mb-4 text-body text-quiet-ink">
        {safePolls.length} poll{safePolls.length !== 1 ? "s" : ""}
      </p>

      <div className="space-y-3">
        {safePolls.map((poll) => (
          <Link key={poll.id} href={`/polls/${poll.id}`} className="block">
            <Card className="p-5 hover:shadow-card transition-shadow">
              <div className="flex flex-col gap-2">
                <h3 className="text-card-heading font-display text-ballot-ink line-clamp-2">
                  {poll.question}
                </h3>
                <div className="flex items-center gap-2 flex-wrap text-micro text-quiet-ink">
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-medium text-xs ${
                      poll.status === "live"
                        ? "bg-signal-gold/10 text-deep-gold"
                        : "bg-soft-fog text-quiet-ink"
                    }`}
                  >
                    {poll.status === "live"
                      ? "Live"
                      : poll.status === "closed"
                        ? "Closed"
                        : poll.status}
                  </span>
                  <span>·</span>
                  <span>
                    {poll.optionCount} option
                    {poll.optionCount !== 1 ? "s" : ""}
                  </span>
                  <span>·</span>
                  <span>
                    {new Date(poll.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span>·</span>
                  <span className={poll.isPublic ? "text-nim-blue" : ""}>
                    {poll.isPublic ? "Public" : "Private"}
                  </span>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </ProductShell>
  );
}
