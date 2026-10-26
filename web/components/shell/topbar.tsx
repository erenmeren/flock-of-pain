"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Play, Save, SlidersHorizontal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Logo } from "@/components/shell/sidebar";
import { useMounted, useTwin } from "@/lib/store";

const EXAMPLE = "__example__";

export function Topbar() {
  const t = useTwin();
  const path = usePathname();
  const mounted = useMounted();
  const items = { [EXAMPLE]: "Reynolds example", ...Object.fromEntries(t.saved.map((c) => [c.id, c.name])) };
  const pick = (v: string | null) => { if (v === EXAMPLE) t.loadExample(); else if (v) t.load(v); };
  return (
    <header className="flex flex-col gap-2">
      <div className="glass flex items-center gap-2 rounded-2xl px-3 py-2">
        <Select value={t.selected || null} items={items} onValueChange={pick} disabled={t.busy}>
          <SelectTrigger aria-label="company" className="h-9 w-72 rounded-full border-transparent glass-inset pl-2">
            <span className="flex items-center gap-2"><Logo className="size-5" /><SelectValue placeholder={mounted && t.company ? `Draft: ${t.company.name}` : "Loading…"} /></span>
          </SelectTrigger>
          <SelectContent>{Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-9 rounded-full px-3" onClick={t.save} disabled={t.busy || !t.company}><Save className="size-4" /> Save</Button>
        <span className="ml-auto hidden text-xs text-muted-foreground md:block">{mounted && `${t.scenarios.length} scenarios · ${t.config.days} days × ${t.config.replications} reps`}</span>
        <Button onClick={t.run} disabled={t.busy || !t.company} size="lg" className="rounded-full px-5 text-[15px]">
          {t.busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} Run Simulation
        </Button>
        <Link href="/settings" aria-label="settings" className={buttonVariants({ variant: "outline", size: "icon-lg", className: "rounded-full" })}><SlidersHorizontal className="size-4" /></Link>
      </div>
      {t.error && path !== "/settings" && (
        <Alert variant="destructive" className="rise">
          <AlertTitle>{t.error.path ?? "Error"}</AlertTitle>
          <AlertDescription>{t.error.message}{t.error.href && <Link href={t.error.href} className="ml-2 underline">Open canvas</Link>}</AlertDescription>
        </Alert>
      )}
    </header>
  );
}
