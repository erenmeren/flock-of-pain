"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Check, Loader2, Play, Plus, Rocket, Sparkles, X } from "lucide-react";
import { cn } from "cn";
import { Panel } from "@/components/dashboard/kpi";
import { RunProgress } from "@/components/shell/run-progress";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useTwin } from "@/lib/store";

const KEY = "flock_getting_started_off";
const listeners = new Set<() => void>();
const read = () => { try { return localStorage.getItem(KEY) === null; } catch { return true; } };
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

export function setGettingStartedOn(on: boolean) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, "1"); } catch { /* private window: setting lives for this page only */ }
  listeners.forEach((l) => l());
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="glass-inset flex flex-col gap-3 rounded-xl p-3">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-full text-xs", done ? "bg-emerald-400/15 text-emerald-400" : "bg-primary/15 text-primary")}>{done ? <Check className="size-3.5" aria-label="done" /> : n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** Dismissible first-steps card on Overview; Settings brings it back. */
export function GettingStarted() {
  const t = useTwin();
  const on = useSyncExternalStore(subscribe, read, () => false);
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  if (!on) return null;
  const noGenerate = t.viewer ? "A viewer cannot generate a company." : !t.me ? "Generating needs step 1: sign in first." : "";
  return (
    <Panel icon={Rocket} title="Getting started" subtitle="Three steps to a first result" className="lg:col-span-12"
      action={<Button variant="outline" size="icon-sm" className="rounded-full" aria-label="dismiss getting started" onClick={() => setGettingStartedOn(false)}><X className="size-4" /></Button>}>
      <div className="grid gap-3 lg:grid-cols-3">
        <Step n={1} title="Sign in" done={!!t.me}>
          {t.me ? <p className="break-words text-xs text-muted-foreground">Signed in as {t.me.email ?? "API key"} ({t.me.role}), tenant {t.me.tenant}.</p> : (
            <>
              <p className="text-xs text-muted-foreground">An account lets you save companies and runs.</p>
              <Link href="/settings" className={buttonVariants({ variant: "outline", size: "sm", className: "self-start rounded-full" })}>Open Settings</Link>
            </>
          )}
        </Step>
        <Step n={2} title="Choose a starting point">
          <Button variant="outline" size="sm" className="self-start rounded-full" onClick={t.loadExample} disabled={t.busy}>Start from the example</Button>
          <div className="flex flex-col gap-2">
            <Textarea aria-label="describe the company" placeholder="Or describe the company in plain words" className="h-16 rounded-xl border-0 glass-inset dark:bg-transparent" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" className="rounded-full" onClick={() => t.generate(prompt)} disabled={t.busy || !prompt.trim() || !!noGenerate}><Sparkles className="size-3.5" /> Generate with Claude</Button>
              {noGenerate && <span className="text-xs text-muted-foreground">{noGenerate}</span>}
            </div>
          </div>
          <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && await t.create(name)) setName(""); }}>
            <Input className="h-8 min-w-0 flex-1 rounded-xl border-0 glass-inset dark:bg-transparent" aria-label="empty company name" placeholder="Or name an empty company" value={name} onChange={(e) => setName(e.target.value)} />
            <Button type="submit" variant="outline" size="sm" className="rounded-full" disabled={t.busy || !name.trim()}><Plus className="size-3.5" /> Create</Button>
          </form>
        </Step>
        <Step n={3} title="Run the simulation" done={!!t.result}>
          <p className="text-xs text-muted-foreground">Results fill this page; the Simulation page has the settings.</p>
          {t.progress ? <RunProgress /> : (
            <Button size="sm" className="self-start rounded-full" onClick={t.run} disabled={t.busy || !t.company}>
              {t.busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Run
            </Button>
          )}
        </Step>
      </div>
    </Panel>
  );
}
