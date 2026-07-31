import { Badge } from "./Badge";

const InfoIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    aria-hidden="true"
    className="ml-1"
  >
    <circle cx="7" cy="7" r="5.75" stroke="currentColor" strokeWidth="1.25" />
    <path
      d="M7 6.5V10"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
    />
    <circle cx="7" cy="4.5" r="0.5" fill="currentColor" />
  </svg>
);

interface FairnessLabelProps {
  rule?: string;
}

export function FairnessLabel({
  rule = "One wallet · one vote",
}: FairnessLabelProps) {
  return (
    <Badge variant="amber">
      {rule}
      <InfoIcon />
    </Badge>
  );
}
