import { XIcon } from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Props = {
  value: readonly string[];
  onValueChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  removeLabel: (tag: string) => string;
  tokenSeparators?: readonly string[];
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitByTokenSeparators = (value: string, tokenSeparators: readonly string[]) => {
  const separators = tokenSeparators.filter((separator) => separator !== "");
  if (!separators.some((separator) => value.includes(separator))) return;
  return value.split(new RegExp(separators.map(escapeRegExp).join("|")));
};

export const TagsInput: React.FC<Props> = ({
  value,
  onValueChange,
  placeholder,
  disabled,
  className,
  id,
  removeLabel,
  tokenSeparators = [",", "\n"],
}) => {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const addMany = (parts: readonly string[]) => {
    const next = [...value];
    for (const raw of parts) {
      const t = raw.trim();
      if (t !== "" && !next.includes(t)) next.push(t);
    }
    if (next.length !== value.length) onValueChange(next);
  };

  const commit = () => {
    if (draft === "") return;
    addMany([draft]);
    setDraft("");
  };

  const remove = (i: number) => onValueChange(value.filter((_, idx) => idx !== i));

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: container focus proxy; inner input handles keyboard
    <fieldset
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-3xl border border-transparent bg-input/50 px-2 py-1.5 transition-[color,box-shadow,background-color] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 has-disabled:pointer-events-none has-disabled:opacity-50",
        className,
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget) inputRef.current?.focus();
      }}
    >
      {value.map((tag, i) => (
        <Badge key={tag} variant="outline" className="h-6 gap-0.5 py-0.5 pr-1 pl-2">
          <span>{tag}</span>
          <button
            type="button"
            onClick={() => remove(i)}
            className="-mr-0.5 rounded-full p-0.5 hover:bg-foreground/15"
            aria-label={removeLabel(tag)}
            disabled={disabled}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        ref={inputRef}
        id={id}
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-[8ch] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || tokenSeparators.includes(e.key)) {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
            e.preventDefault();
            onValueChange(value.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text");
          const parts = splitByTokenSeparators(text, tokenSeparators);
          if (!parts) return;
          e.preventDefault();
          addMany(parts);
        }}
      />
    </fieldset>
  );
};
