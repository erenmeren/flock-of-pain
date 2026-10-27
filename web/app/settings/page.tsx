"use client";

import { useState } from "react";
import { Braces, Database, Download, KeyRound, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Panel } from "@/components/dashboard/kpi";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type ApiError, signup } from "@/lib/api";
import { parseCompany, parseScenarios, slug } from "@/lib/company";
import { useTwin } from "@/lib/store";

/** Textarea over a store value: local text while typing, reset whenever the store value changes. */
function JsonBox({ label, value, apply }: { label: string; value: unknown; apply: (text: string) => void }) {
  const [seen, setSeen] = useState(value);
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  if (seen !== value) { // render-time reset (React's "adjust state when a prop changes" pattern)
    setSeen(value);
    setText(JSON.stringify(value, null, 2));
  }
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <Textarea aria-label={label} className="h-72 rounded-xl border-0 font-mono text-xs glass-inset [scrollbar-color:oklch(1_0_0/0.15)_transparent] dark:bg-transparent" value={text} onChange={(e) => setText(e.target.value)} />
      <div><Button variant="outline" size="sm" className="rounded-full" onClick={() => apply(text)}>Apply {label}</Button></div>
    </div>
  );
}

export default function Settings() {
  const t = useTwin();
  const [prompt, setPrompt] = useState("");
  const [newName, setNewName] = useState("");
  const [tenant, setTenant] = useState("");
  const [invite, setInvite] = useState("");
  const [signingUp, setSigningUp] = useState(false);
  const create = async () => { if (newName.trim() && await t.create(newName)) setNewName(""); };
  const doSignup = async () => {
    setSigningUp(true);
    try {
      const r = await signup(slug(tenant), invite);
      t.changeKey(r.key); // the key is shown once by the API; the field below keeps it
      t.setError(null);
      setTenant(""); setInvite("");
    } catch (e) { t.setError(e as ApiError); } finally { setSigningUp(false); }
  };

  const tryApply = (fn: () => void) => {
    try { fn(); t.setError(null); } catch (e) { t.setError({ path: null, message: `Invalid JSON: ${(e as Error).message}` }); }
  };
  const download = () => {
    const blob = new Blob([JSON.stringify({ company: t.company, scenarios: t.scenarios }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${t.company?.id ?? "company"}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" subtitle="API key, generation, saved companies and raw JSON" />

      {t.error && (
        <Alert variant="destructive">
          <AlertTitle>{t.error.path ?? "Error"}</AlertTitle>
          <AlertDescription>{t.error.message}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="API Key" subtitle="Tenant key for the simulation API" icon={KeyRound}>
          <div className="flex flex-col gap-2">
            {/* keyed so the stored key, read after mount, becomes the default */}
            <Input key={t.apiKey} type="password" className="h-9 rounded-xl border-0 font-mono glass-inset dark:bg-transparent" aria-label="api key" placeholder="tenant API key" defaultValue={t.apiKey}
              onBlur={(e) => { if (e.target.value !== t.apiKey) t.changeKey(e.target.value); }} />
            <p className="text-xs text-muted-foreground">Create one with <code className="font-mono">flock_of_pain tenant create</code>, or sign up below when the API hands out invite codes. Saved when the field loses focus; stored in this browser only.</p>
            <form className="mt-1 flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); doSignup(); }}>
              <Input className="h-9 min-w-32 flex-1 rounded-xl border-0 glass-inset dark:bg-transparent" aria-label="tenant id" placeholder="Tenant id" value={tenant} onChange={(e) => setTenant(e.target.value)} disabled={signingUp} />
              <Input className="h-9 min-w-32 flex-1 rounded-xl border-0 glass-inset dark:bg-transparent" aria-label="invite code" placeholder="Invite code" value={invite} onChange={(e) => setInvite(e.target.value)} disabled={signingUp} />
              <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={signingUp || !slug(tenant) || !invite}>{signingUp ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Sign up</Button>
            </form>
          </div>
        </Panel>

        <Panel title="Generate with AI" subtitle="Describe a company; Claude drafts the twin" icon={Sparkles}>
          <div className="flex flex-col gap-2">
            <Textarea aria-label="company description" placeholder="Describe the company in words; Claude writes the twin" className="h-24 rounded-xl border-0 glass-inset dark:bg-transparent" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex items-center gap-3">
              <Button className="rounded-full px-4" onClick={() => t.generate(prompt)} disabled={t.busy || !prompt.trim()}>
                {t.busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Generate
              </Button>
              <span className="text-xs text-muted-foreground">Replaces the current draft (company and scenarios).</span>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Saved Companies" subtitle={`${t.saved.length} stored for this tenant`} icon={Database}
        action={<Button variant="outline" size="sm" className="rounded-full" onClick={t.loadExample} disabled={t.busy}>Load Reynolds example</Button>}>
        <div className="flex flex-col gap-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); create(); }}>
            <Input className="h-9 rounded-xl border-0 glass-inset dark:bg-transparent" aria-label="new company name" placeholder="New company name" value={newName} onChange={(e) => setNewName(e.target.value)} disabled={t.busy} />
            <Button type="submit" variant="outline" size="sm" className="h-9 rounded-full px-3" disabled={t.busy || !newName.trim()}><Plus className="size-3.5" /> Create empty</Button>
          </form>
          {t.saved.length === 0 && <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No saved companies{t.apiKey ? "" : " (set an API key first)"}.</p>}
          {t.saved.map((c) => (
            <div key={c.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl glass-inset px-3 py-2.5 text-sm", t.selected === c.id && "ring-1! ring-primary/40")}>
              <span className="flex size-8 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">{c.name.slice(0, 2).toUpperCase()}</span>
              <span className="font-medium">{c.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
              {t.selected === c.id && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">loaded</span>}
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">{c.updated_at.replace("T", " ").replace("+00:00", "")}</span>
              <Button variant="ghost" size="sm" className="rounded-full" onClick={() => t.load(c.id)} disabled={t.busy}>Load</Button>
              <Button variant="ghost" size="sm" className="rounded-full text-rose-400 hover:bg-rose-400/10 hover:text-rose-300" onClick={() => t.remove(c.id)} disabled={t.busy}><Trash2 className="size-3.5" /> Delete</Button>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Raw JSON" subtitle="Edit the draft directly; Apply validates" icon={Braces}
        action={t.company ? <Button variant="outline" size="sm" className="rounded-full" onClick={download}><Download className="size-3.5" /> Download (.json)</Button> : undefined}>
        {t.company ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <JsonBox label="company" value={t.company} apply={(x) => tryApply(() => t.setCompany(parseCompany(x)))} />
            <JsonBox label="scenarios" value={t.scenarios} apply={(x) => tryApply(() => t.setScenarios(parseScenarios(x)))} />
          </div>
        ) : <p className="text-sm text-muted-foreground">Loading…</p>}
      </Panel>
    </div>
  );
}
