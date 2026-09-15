export type ParticipationCampaignType =
  | "public_giveaway"
  | "secret_drop"
  | "private_drop"
  | "event_drop"
  | "community_reward";

export type ParticipationCampaignStatus =
  | "draft"
  | "published"
  | "closed"
  | "expired"
  | "cancelled";

export type CampaignVisibility = "public" | "unlisted" | "private";

export interface CampaignConfiguration {
  campaignId: string;
  settlementId: string;
  ownerWallet: string;
  campaignType: ParticipationCampaignType;
  visibility: CampaignVisibility;
  title: string;
  description: string | null;
  status: ParticipationCampaignStatus;
  configurationVersion: number;
  publishedConfigurationVersion: number | null;
  startsAt: string | null;
  endsAt: string | null;
  closeReason: string | null;
  configurationLockedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
