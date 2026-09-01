"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { WalletButton } from "@/components/ui/WalletButton";
import { WalletIconLarge } from "@/components/ui/icons";
import { LoadingState } from "@/components/state/LoadingState";
import { WalletRequiredState } from "@/components/state/WalletRequiredState";
import { RewardFundingPanel } from "@/components/creator/RewardFundingPanel";
import { useNimiqContext } from "@/providers/NimiqProvider";
import { useVotumSession } from "@/providers/VotumSessionProvider";

function ManagementPrompt({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: ReactNode;
}) {
  return (
    <Card
      glass
      className="mx-auto flex w-full max-w-md flex-col items-center justify-center px-5 py-16 text-center"
    >
      <div className="mb-6 text-signal-gold opacity-80">
        <WalletIconLarge />
      </div>
      <h2 className="text-section-heading font-display text-ballot-ink text-center">
        {title}
      </h2>
      <p className="text-body text-quiet-ink max-w-sm text-center mt-3">
        {description}
      </p>
      <div className="mt-8">{action}</div>
    </Card>
  );
}

export function CreatorManagementGate({ pollId }: { pollId: string }) {
  const { runtimeStatus, walletStatus } = useNimiqContext();
  const {
    status,
    isSessionVerified,
    isWalletMatched,
    verifyActiveWallet,
  } = useVotumSession();

  if (status === "loading" || runtimeStatus === "idle" || runtimeStatus === "initializing") {
    return <LoadingState variant="list" count={1} />;
  }

  if (walletStatus !== "connected") {
    return (
      <WalletRequiredState
        title="Connect your wallet to manage this poll."
        description="Connect your Nimiq wallet to access creator controls for this poll."
      />
    );
  }

  if (!isSessionVerified) {
    return (
      <ManagementPrompt
        title="Verify wallet ownership to manage this poll."
        description="Your wallet is connected but not yet verified. Verify ownership to access creator controls."
        action={
          <Button type="button" variant="primary" onClick={verifyActiveWallet}>
            Verify wallet ownership
          </Button>
        }
      />
    );
  }

  if (!isWalletMatched) {
    return (
      <ManagementPrompt
        title="This wallet cannot manage this poll."
        description="Switch to the wallet that created this Votum Poll, then try again."
        action={<WalletButton />}
      />
    );
  }

  return <RewardFundingPanel pollId={pollId} />;
}
