"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Menu, Play, Redo2, Save, SlidersHorizontal, Undo2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RunProgress } from "@/components/shell/run-progress";
import { Logo, Sidebar } from "@/components/shell/sidebar";
import { undoKey } from "@/lib/history";
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
  const { undo, redo } = t;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = undoKey(e);
      if (!action || (e.target as Element | null)?.closest?.("input,textarea,[contenteditable]:not([contenteditable='false'])")) return; // text fields keep native undo
      e.preventDefault();
      if (action === "undo") undo(); else redo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);
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
        {!(mounted && t.viewer) && <Button variant="outline" size="sm" className="h-9 rounded-full px-3" onClick={t.save} disabled={!mounted || t.busy || !t.company}><Save className="size-4" /> <span className="hidden sm:inline">Save</span></Button>}
        <Button variant="outline" size="icon-lg" className="rounded-full" aria-label="undo" title="Undo (Ctrl+Z)" onClick={t.undo} disabled={!t.canUndo}><Undo2 className="size-4" /></Button>
        <Button variant="outline" size="icon-lg" className="rounded-full" aria-label="redo" title="Redo (Ctrl+Shift+Z)" onClick={t.redo} disabled={!t.canRedo}><Redo2 className="size-4" /></Button>
        {t.progress ? <RunProgress className="ml-auto w-44 lg:w-64" /> : <span className="ml-auto hidden text-xs text-muted-foreground md:block">{mounted && `${t.scenarios.length} scenarios · ${t.config.days} days × ${t.config.replications} reps`}</span>}
        <Button onClick={t.run} disabled={!mounted || t.busy || !t.company} size="lg" className="rounded-full px-5 text-[15px]">
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
      {mounted && t.conflict && (
        <Alert className="rise">
          <AlertTitle>Someone else saved {t.conflict.id} since you loaded it</AlertTitle>
          <AlertDescription>
            Their version is from {t.conflict.updated_at.replace("T", " ").replace("+00:00", "")}. Autosave is paused until you choose which version to keep.
            <span className="mt-2 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => t.conflict && t.load(t.conflict.id)} disabled={t.busy}>Load their version</Button>
              <Button variant="outline" size="sm" className="rounded-full" onClick={t.overwrite} disabled={t.busy || t.viewer}>Overwrite with mine</Button>
            </span>
          </AlertDescription>
        </Alert>
      )}
      {t.error && path !== "/settings" && (
        <Alert variant="destructive" className="rise">
          <AlertTitle>{t.error.path ?? "Error"}</AlertTitle>
          <AlertDescription>{t.error.message}{t.error.href && <Link href={t.error.href} className="ml-2 underline">{t.error.href === "/settings" ? "Open Settings" : "Open canvas"}</Link>}</AlertDescription>
        </Alert>
      )}
    </header>
  );
}
