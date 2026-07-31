"use client";

import type { InputHTMLAttributes } from "react";
import { forwardRef, useId } from "react";
import { FormField } from "./FormField";

interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  label?: string;
  error?: string;
  hint?: string;
  className?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className = "", id, onChange, ...rest }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;

    const handleInput = onChange
      ? (e: React.FormEvent<HTMLInputElement>) => {
          onChange(e as unknown as React.ChangeEvent<HTMLInputElement>);
        }
      : undefined;

    return (
      <FormField label={label} hint={hint} error={error} htmlFor={inputId}>
        <input
          ref={ref}
          id={inputId}
          className={`w-full rounded-full border border-border bg-clear-ballot/72 px-4 py-3 text-sm text-ballot-ink placeholder:text-micro-grey transition-colors focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold disabled:opacity-50 ${className}`}
          onInput={handleInput}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={
            error
              ? `${inputId}-error`
              : hint
                ? `${inputId}-hint`
                : undefined
          }
          {...rest}
        />
      </FormField>
    );
  },
);

Input.displayName = "Input";
