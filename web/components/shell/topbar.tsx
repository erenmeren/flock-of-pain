"use client";

import { usePathname } from "next/navigation";
import { Loader2, Play, Save } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useTwin } from "@/lib/store";

const EXAMPLE = "__example__";

export function Topbar() {
  const t = useTwin();
  const path = usePathname();
  const items = { [EXAMPLE]: "Reynolds example", ...Object.fromEntries(t.saved.map((c) => [c.id, c.name])) };
  const pick = (v: string | null) => { if (v === EXAMPLE) t.loadExample(); else if (v) t.load(v); };
  return (
    <header className="flex flex-col gap-2 border-b border-border px-6 py-3">
      <div className="flex items-center gap-3">
        <Select value={t.selected || null} items={items} onValueChange={pick}>
          <SelectTrigger aria-label="company" className="w-64"><SelectValue placeholder={t.company ? `Draft: ${t.company.name}` : "Loading…"} /></SelectTrigger>
          <SelectContent>{Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={t.save} disabled={t.busy || !t.company}><Save className="size-4" /> Save</Button>
        <span className="ml-auto text-xs text-muted-foreground">{t.scenarios.length} scenarios · {t.config.days} days × {t.config.replications} reps</span>
        <Button onClick={t.run} disabled={t.busy || !t.company} className="shadow-[0_0_18px_-2px_var(--primary)]">
          {t.busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run Simulation
        </Button>
      </div>
      {t.error && path !== "/settings" && (
        <Alert variant="destructive">
          <AlertTitle>{t.error.path ?? "Error"}</AlertTitle>
          <AlertDescription>{t.error.message}</AlertDescription>
        </Alert>
      )}
    </header>
  );
}
