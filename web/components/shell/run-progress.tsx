"use client";

import { X } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useTwin } from "@/lib/store";

/** Progress bar and Cancel for the run under way; renders nothing otherwise. */
export function RunProgress({ className }: { className?: string }) {
  const { progress, cancelling, cancelRun } = useTwin();
  if (!progress) return null;
  const { done, total } = progress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs tabular-nums text-muted-foreground">{cancelling ? "Cancelling…" : total ? `${done} of ${total} replications` : "Starting…"}</span>
        <div role="progressbar" aria-label="simulation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="glass-inset h-1.5 overflow-hidden rounded-full">
          <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Button variant="outline" size="sm" className="shrink-0 rounded-full" onClick={cancelRun} disabled={cancelling}><X className="size-3.5" /> Cancel</Button>
    </div>
  );
}
