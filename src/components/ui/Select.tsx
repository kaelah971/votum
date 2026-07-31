"use client";

import type { SelectHTMLAttributes } from "react";
import { forwardRef, useId } from "react";
import { FormField } from "./FormField";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  label?: string;
  error?: string;
  hint?: string;
  options: SelectOption[];
  className?: string;
  placeholder?: string;
}

const ChevronIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-quiet-ink"
  >
    <path
      d="M4 6L8 10L12 6"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  (
    {
      label,
      error,
      hint,
      options,
      className = "",
      placeholder,
      id,
      ...rest
    },
    ref,
  ) => {
    const generatedId = useId();
    const selectId = id ?? generatedId;

    return (
      <FormField label={label} hint={hint} error={error} htmlFor={selectId}>
        <div className="relative">
          <select
            ref={ref}
            id={selectId}
            className={`w-full appearance-none rounded-full border border-border bg-clear-ballot/72 px-4 py-3 pr-10 text-sm text-ballot-ink transition-colors focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold disabled:opacity-50 ${className}`}
            aria-invalid={error ? "true" : undefined}
            aria-describedby={
              error
                ? `${selectId}-error`
                : hint
                  ? `${selectId}-hint`
                  : undefined
            }
            {...rest}
          >
            {placeholder && (
              <option value="" disabled>
                {placeholder}
              </option>
            )}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <ChevronIcon />
        </div>
      </FormField>
    );
  },
);

Select.displayName = "Select";
