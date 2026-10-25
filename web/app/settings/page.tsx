"use client";

import { useState } from "react";
import { Download, Loader2, Sparkles } from "lucide-react";
import { Panel } from "@/components/dashboard/kpi";
import { PageHeader } from "@/components/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { parseCompany, parseScenarios } from "@/lib/company";
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
      <Textarea aria-label={label} className="h-72 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
      <div><Button variant="outline" size="sm" onClick={() => apply(text)}>Apply {label}</Button></div>
    </div>
  );
}

export default function Settings() {
  const t = useTwin();
  const [prompt, setPrompt] = useState("");

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
        <Panel title="API Key">
          <div className="flex flex-col gap-2">
            {/* keyed so the stored key, read after mount, becomes the default */}
            <Input key={t.apiKey} type="password" aria-label="api key" placeholder="tenant API key" defaultValue={t.apiKey}
              onBlur={(e) => { if (e.target.value !== t.apiKey) t.changeKey(e.target.value); }} />
            <p className="text-xs text-muted-foreground">Create one with <code className="font-mono">flock_of_pain tenant create</code>. Saved when the field loses focus; stored in this browser only.</p>
          </div>
        </Panel>

        <Panel title="Generate with Claude">
          <div className="flex flex-col gap-2">
            <Textarea aria-label="company description" placeholder="Describe the company in words; Claude writes the twin" className="h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <div className="flex items-center gap-3">
              <Button onClick={() => t.generate(prompt)} disabled={t.busy || !prompt.trim()}>
                {t.busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Generate
              </Button>
              <span className="text-xs text-muted-foreground">Replaces the current draft (company and scenarios).</span>
            </div>
          </div>
        </Panel>
      </div>

      <Panel title="Saved Companies">
        <div className="flex flex-col gap-2">
          {t.saved.length === 0 && <p className="text-sm text-muted-foreground">No saved companies{t.apiKey ? "" : " (set an API key first)"}.</p>}
          {t.saved.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2 text-sm">
              <span className="font-medium">{c.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
              {t.selected === c.id && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">loaded</span>}
              <span className="ml-auto text-xs text-muted-foreground">{c.updated_at.replace("T", " ").replace("+00:00", "")}</span>
              <Button variant="outline" size="sm" onClick={() => t.load(c.id)} disabled={t.busy}>Load</Button>
              <Button variant="destructive" size="sm" onClick={() => t.remove(c.id)} disabled={t.busy}>Delete</Button>
            </div>
          ))}
          <div><Button variant="outline" size="sm" onClick={t.loadExample} disabled={t.busy}>Load Reynolds example</Button></div>
        </div>
      </Panel>

      <Panel title="Advanced JSON">
        {t.company ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <JsonBox label="company" value={t.company} apply={(x) => tryApply(() => t.setCompany(parseCompany(x)))} />
              <JsonBox label="scenarios" value={t.scenarios} apply={(x) => tryApply(() => t.setScenarios(parseScenarios(x)))} />
            </div>
            <div><Button variant="outline" size="sm" onClick={download}><Download className="size-3.5" /> Download (.json)</Button></div>
          </div>
        ) : <p className="text-sm text-muted-foreground">Loading…</p>}
      </Panel>
    </div>
  );
}
