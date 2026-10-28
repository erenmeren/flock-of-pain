"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Menu, Play, Save, SlidersHorizontal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Logo, Sidebar } from "@/components/shell/sidebar";
import { useMounted, useTwin } from "@/lib/store";

const EXAMPLE = "__example__";

export function Topbar() {
  const t = useTwin();
  const path = usePathname();
  const mounted = useMounted();
  const [menuAt, setMenuAt] = useState<string | null>(null); // path the drawer was opened on: navigating closes it
  const menu = menuAt === path;
  const items = { [EXAMPLE]: "Reynolds example", ...Object.fromEntries(t.saved.map((c) => [c.id, c.name])) };
  const pick = (v: string | null) => { if (v === EXAMPLE) t.loadExample(); else if (v) t.load(v); };
  return (
    <header data-shell className="flex flex-col gap-2">
      <div className="glass flex items-center gap-2 rounded-2xl px-3 py-2">
        <Button variant="outline" size="icon-lg" className="rounded-full lg:hidden" aria-label="menu" onClick={() => setMenuAt(path)}><Menu className="size-4" /></Button>
        <Select value={t.selected || null} items={items} onValueChange={pick} disabled={t.busy}>
          <SelectTrigger aria-label="company" className="h-9 min-w-0 flex-1 rounded-full border-transparent glass-inset pl-2 sm:flex-none sm:w-72">
            <span className="flex items-center gap-2"><Logo className="size-5" /><SelectValue placeholder={mounted && t.company ? `Draft: ${t.company.name}` : "Loading…"} /></span>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>{Object.entries(items).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" size="sm" className="h-9 rounded-full px-3" onClick={t.save} disabled={t.busy || !t.company}><Save className="size-4" /> <span className="hidden sm:inline">Save</span></Button>
        <span className="ml-auto hidden text-xs text-muted-foreground md:block">{mounted && `${t.scenarios.length} scenarios · ${t.config.days} days × ${t.config.replications} reps`}</span>
        <Button onClick={t.run} disabled={t.busy || !t.company} size="lg" className="rounded-full px-5 text-[15px]">
          {t.busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 fill-current" />} <span className="hidden sm:inline">Run Simulation</span>
        </Button>
        <Link href="/settings" aria-label="settings" className={buttonVariants({ variant: "outline", size: "icon-lg", className: "rounded-full" })}><SlidersHorizontal className="size-4" /></Link>
      </div>
      {menu && (
        <div className="fixed inset-0 z-50 p-3 lg:hidden">
          <button type="button" aria-label="close menu" className="absolute inset-0 bg-black/60" onClick={() => setMenuAt(null)} />
          <Sidebar className="relative h-full" />
        </div>
      )}
      {t.error && path !== "/settings" && (
        <Alert variant="destructive" className="rise">
          <AlertTitle>{t.error.path ?? "Error"}</AlertTitle>
          <AlertDescription>{t.error.message}{t.error.href && <Link href={t.error.href} className="ml-2 underline">Open canvas</Link>}</AlertDescription>
        </Alert>
      )}
    </header>
  );
}
