"use client"; // error boundaries must be client components

import { Button } from "@/components/ui/button";

/** Any render error shows its message instead of a blank page; a bad draft is the usual cause, so it can be dropped here. */
export default function ErrorPage({ error }: { error: unknown }) {
  const resetDraft = () => {
    localStorage.removeItem("flock_draft");
    location.reload();
  };
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-4 py-10">
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="max-w-xl text-center font-mono text-xs text-muted-foreground">{error instanceof Error ? error.message : String(error)}</p>
      <Button variant="destructive" size="sm" className="rounded-full" onClick={resetDraft}>Reset draft</Button>
    </div>
  );
}
