"use client";

import { NimiqProvider } from "@/providers/NimiqProvider";
import { VotumSessionProvider } from "@/providers/VotumSessionProvider";
import { OnboardingProvider } from "@/providers/OnboardingProvider";
import type { ReactNode } from "react";

export function ClientProviders({ children }: { children: ReactNode }) {
  return (
    <NimiqProvider>
      <VotumSessionProvider>
        <OnboardingProvider>
          {children}
        </OnboardingProvider>
      </VotumSessionProvider>
    </NimiqProvider>
  );
}
