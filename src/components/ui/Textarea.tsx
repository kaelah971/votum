"use client";

import type { TextareaHTMLAttributes } from "react";
import { forwardRef, useId } from "react";
import { FormField } from "./FormField";

interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  label?: string;
  error?: string;
  hint?: string;
  className?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, className = "", id, onChange, ...rest }, ref) => {
    const generatedId = useId();
    const textareaId = id ?? generatedId;

    const handleInput = onChange
      ? (e: React.FormEvent<HTMLTextAreaElement>) => {
          onChange(e as unknown as React.ChangeEvent<HTMLTextAreaElement>);
        }
      : undefined;

    return (
      <FormField label={label} hint={hint} error={error} htmlFor={textareaId}>
        <textarea
          ref={ref}
          id={textareaId}
          className={`min-h-[120px] w-full resize-y rounded-[22px] border border-border bg-clear-ballot/72 px-4 py-3 text-sm text-ballot-ink placeholder:text-micro-grey transition-colors focus:border-signal-gold focus:outline-none focus:ring-1 focus:ring-signal-gold disabled:opacity-50 ${className}`}
          onInput={handleInput}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={
            error
              ? `${textareaId}-error`
              : hint
                ? `${textareaId}-hint`
                : undefined
          }
          {...rest}
        />
      </FormField>
    );
  },
);

Textarea.displayName = "Textarea";
