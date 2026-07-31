import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductShell } from "@/components/layout/ProductShell";
import { getPublicPollById } from "@/lib/data/public-polls";
import PollVotingPanel from "@/components/poll/PollVotingPanel";
import { PollNimSupportPanel } from "@/components/poll/PollNimSupportPanel";
import { UnavailableState } from "@/components/state/UnavailableState";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ pollId: string }>;
}) {
  const { pollId } = await params;
  const result = await getPublicPollById(pollId);

  if (result.success) {
    return {
      title: result.poll.question,
      description:
        result.poll.context ?? "View a NIM-backed community decision on Votum.",
    };
  }

  return {
    title: "Votum Poll",
    description:
      "View a NIM-backed community decision. Poll data is fetched from the Votum data layer.",
  };
}

// ---------------------------------------------------------------------------
// Page component (server component)
// ---------------------------------------------------------------------------

export default async function PollPage({
  params,
  searchParams,
}: {
  params: Promise<{ pollId: string }>;
  searchParams: Promise<{ published?: string }>;
}) {
  const { pollId } = await params;
  const { published } = await searchParams;
  const wasJustPublished = published === "1";

  const result = await getPublicPollById(pollId);
  if (!result.success) {
    if (result.reason === "not_found") notFound();
    return (
      <ProductShell>
        <UnavailableState
          title="Poll data is not available"
          description="Poll data will appear here once the Votum data layer is connected."
        />
      </ProductShell>
    );
  }

  return (
    <ProductShell>
      {wasJustPublished && (
        <div className="mb-6 rounded-card bg-verified-green/[0.08] border border-verified-green/20 px-5 py-4">
          <p className="text-body font-medium text-verified-green flex items-center gap-2">
            Poll published successfully.
          </p>
          <div className="flex items-center gap-4 mt-2">
            <Link
              href="/my-polls"
              className="text-sm text-nim-blue hover:text-signal-gold transition-colors"
            >
              View My Polls
            </Link>
            <Link
              href="/explore"
              className="text-sm text-nim-blue hover:text-signal-gold transition-colors"
            >
              Browse public polls
            </Link>
          </div>
        </div>
      )}
      <PollVotingPanel poll={result.poll} />
      <PollNimSupportPanel
        pollId={result.poll.id}
        options={result.poll.options}
        isLive={result.poll.status === "live"}
        minimumNim={result.poll.minimumNim}
      />
    </ProductShell>
  );
}
