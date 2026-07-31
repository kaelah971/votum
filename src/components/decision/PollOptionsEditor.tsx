"use client";

import type { ChangeEvent } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CloseIcon } from "@/components/ui/icons";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PollOptionsEditorProps {
  options: string[];
  onChange: (options: string[]) => void;
  errors: (string | undefined)[];
  maxOptions?: number; // default 6
  minOptions?: number; // default 2
}

export function PollOptionsEditor({
  options,
  onChange,
  errors,
  maxOptions = 6,
  minOptions = 2,
}: PollOptionsEditorProps) {
  function updateOption(index: number, value: string) {
    const next = [...options];
    next[index] = value;
    onChange(next);
  }

  function addOption() {
    if (options.length >= maxOptions) return;
    onChange([...options, ""]);
  }

  function removeOption(index: number) {
    if (options.length <= minOptions) return;
    const next = options.filter((_, i) => i !== index);
    onChange(next);
  }

  return (
    <Card className="p-5">
      <div className="flex flex-col gap-4">
        {options.map((option, index) => (
          <div key={index} className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <Input
                label={`Option ${index + 1}`}
                value={option}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  updateOption(index, e.target.value)
                }
                placeholder={`Option ${index + 1}`}
                error={errors[index]}
              />
            </div>
            {options.length > minOptions && (
              <button
                type="button"
                onClick={() => removeOption(index)}
                aria-label={`Remove option ${index + 1}`}
                className="flex items-center justify-center w-10 h-10 rounded-full text-quiet-ink hover:text-reject-red hover:bg-soft-fog transition-colors flex-shrink-0 mt-7"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        ))}

        {options.length < maxOptions && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addOption}
          >
            Add another option
          </Button>
        )}
      </div>
    </Card>
  );
}
