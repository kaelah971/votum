import { WalletButton } from "@/components/ui/WalletButton";
import { WalletIconLarge } from "@/components/ui/icons";

interface WalletRequiredStateProps {
  title?: string;
  description?: string;
  className?: string;
}

export function WalletRequiredState({
  title = "Wallet required",
  description = "Connect your Nimiq wallet to participate in Votum polls and back choices with NIM.",
  className = "",
}: WalletRequiredStateProps) {
  return (
    <div
      className={`mx-auto flex w-full max-w-md flex-col items-center justify-center rounded-[24px] border border-white/75 bg-clear-ballot/64 px-5 py-16 text-center shadow-card backdrop-blur ${className}`}
    >
      <div className="mb-6 text-signal-gold opacity-80">
        <WalletIconLarge />
      </div>
      <h2 className="text-section-heading font-display text-ballot-ink">
        {title}
      </h2>
      <p className="mt-3 max-w-sm text-body text-quiet-ink">
        {description}
      </p>
      <div className="mt-8">
        <WalletButton />
      </div>
    </div>
  );
}
