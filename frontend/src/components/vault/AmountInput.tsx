"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";

import { fmtNum } from "@/lib/format";

/** Parse a user-typed decimal amount into base units; null when empty or malformed. */
export function parseAmount(input: string, decimals: number): bigint | null {
  const t = input.trim().replace(/,/g, "");
  if (!t || t === "." || !/^\d*\.?\d*$/.test(t)) return null;
  try {
    return parseUnits(t, decimals);
  } catch {
    return null;
  }
}

/** Base units -> display string. */
export function fmtUnits(v: bigint | undefined | null, decimals: number, digits = 2): string {
  if (v === undefined || v === null) return "—";
  return fmtNum(Number(formatUnits(v, decimals)), digits);
}

/** Exact base units -> input string (for "Max" buttons). */
export function unitsToInput(v: bigint, decimals: number): string {
  return formatUnits(v, decimals);
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface AmountInputProps {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange: (v: string) => void;
  onMax?: () => void;
  maxLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
}

export function AmountInput({ id, label, unit, value, onChange, onMax, maxLabel, disabled, invalid }: AmountInputProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-ink-2">
          {label}
        </label>
        {maxLabel && <span className="truncate text-[0.7rem] text-muted">{maxLabel}</span>}
      </div>
      <div className="flex items-stretch gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={id}
            className={`input pr-16 text-base ${invalid ? "border-crit/70" : ""}`}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted">{unit}</span>
        </div>
        {onMax && (
          <button type="button" className="btn btn-ghost px-3" onClick={onMax} disabled={disabled}>
            Max
          </button>
        )}
      </div>
    </div>
  );
}
