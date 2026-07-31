"use client";

interface RadioProps {
  name: string;
  value: string;
  label: string;
  description?: string;
  checked?: boolean;
  onChange?: (value: string) => void;
  disabled?: boolean;
}

export function Radio({
  name,
  value,
  label,
  description,
  checked = false,
  onChange,
  disabled = false,
}: RadioProps) {
  return (
    <label
      className={`flex items-start gap-3 w-full px-4 py-3 rounded-card border cursor-pointer transition-colors
        ${
          checked
            ? "border-signal-gold bg-signal-gold/[0.04]"
            : "border-border hover:border-micro-grey"
        }
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
    >
      <span className="mt-0.5 flex-shrink-0 relative">
        {/* Visually hidden native radio for accessibility */}
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={(e) => {
            if (onChange && e.target.checked) {
              onChange(value);
            }
          }}
          className="sr-only"
        />
        {/* Custom radio circle */}
        <span
          className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors
            ${
              checked
                ? "border-signal-gold bg-signal-gold"
                : "border-micro-grey bg-clear-ballot"
            }
          `}
          aria-hidden="true"
        >
          {checked && (
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          )}
        </span>
      </span>

      <span className="flex flex-col min-w-0">
        <span
          className={`text-sm leading-snug text-ballot-ink ${
            checked ? "font-medium" : ""
          }`}
        >
          {label}
        </span>
        {description && (
          <span className="text-micro text-quiet-ink mt-0.5">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
