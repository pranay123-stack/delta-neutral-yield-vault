import type { ReactNode } from "react";

/** Server-rendered page heading, so every route's title is in the initial HTML. */
export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-[0.8125rem] leading-relaxed text-ink-2">{description}</p>}
      </div>
      {children}
    </div>
  );
}
