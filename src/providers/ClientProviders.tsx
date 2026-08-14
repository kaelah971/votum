"use client";

import { NimiqProvider } from "@/providers/NimiqProvider";
import { VotumSessionProvider } from "@/providers/VotumSessionProvider";
import { OnboardingProvider } from "@/providers/OnboardingProvider";
import { WalletOnboardingSheet } from "@/components/onboarding/WalletOnboardingSheet";
import type { ReactNode } from "react";

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <NimiqProvider>
      <VotumSessionProvider>
        <OnboardingProvider>
          {children}
          <WalletOnboardingSheet />
        </OnboardingProvider>
      </VotumSessionProvider>
    </NimiqProvider>
  );
}
