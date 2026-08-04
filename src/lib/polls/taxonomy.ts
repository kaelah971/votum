export const POLL_CATEGORIES = [
  "sports",
  "entertainment",
  "brands_products",
  "communities",
  "other",
] as const;

export type PollCategory = (typeof POLL_CATEGORIES)[number];

export const POLL_FORMATS = [
  "decision",
  "prediction",
  "fan_vote",
  "ranking",
  "nomination",
  "audience_choice",
] as const;

export type PollFormat = (typeof POLL_FORMATS)[number];

export function isPollCategory(value: unknown): value is PollCategory {
  return (
    typeof value === "string" &&
    (POLL_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isPollFormat(value: unknown): value is PollFormat {
  return (
    typeof value === "string" &&
    (POLL_FORMATS as readonly string[]).includes(value)
  );
}

export const CATEGORY_LABELS: Record<PollCategory, string> = {
  sports: "Sports",
  entertainment: "Entertainment",
  brands_products: "Brands & Products",
  communities: "Communities",
  other: "Other",
};

export const FORMAT_LABELS: Record<PollFormat, string> = {
  decision: "Decision",
  prediction: "Prediction",
  fan_vote: "Fan vote",
  ranking: "Ranking",
  nomination: "Nomination",
  audience_choice: "Audience choice",
};

export function normalizeCategory(value: unknown): PollCategory {
  if (isPollCategory(value)) return value;
  return "communities";
}

export function normalizeFormat(value: unknown): PollFormat {
  if (isPollFormat(value)) return value;
  return "decision";
}
