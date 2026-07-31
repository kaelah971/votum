import type { ReactNode } from "react";

interface FormFieldProps {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}

export function FormField({
  label,
  hint,
  error,
  children,
  htmlFor,
}: FormFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label
          htmlFor={htmlFor}
          className="text-sm font-medium text-ballot-ink"
        >
          {label}
        </label>
      )}
      {children}
      {hint && !error && (
        <p className="text-micro text-quiet-ink" id={htmlFor ? `${htmlFor}-hint` : undefined}>
          {hint}
        </p>
      )}
      {error && (
        <p className="text-micro text-reject-red" id={htmlFor ? `${htmlFor}-error` : undefined} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
