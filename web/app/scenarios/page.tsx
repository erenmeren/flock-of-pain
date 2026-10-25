"use client";

import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/page";
import { IdInput, uniqueId } from "@/components/editor-fields";
import { DAY, MinuteRange, OverlayEditor, Pick, newOverlay, systemItems } from "@/components/scenario/overlay-editor";
import { type Company, type Scenario, OVERLAY_TYPES } from "@/lib/company";
import { useTwin } from "@/lib/store";

export default function ScenariosPage() {
  const { company, setCompany, scenarios, setScenarios } = useTwin();
  const [sel, setSel] = useState(0);
  if (!company) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const i = Math.min(sel, scenarios.length - 1);
  const s = scenarios[i];
  const setS = (x: Scenario) => setScenarios(scenarios.map((y, j) => (j === i ? x : y)));
  const add = (x: Omit<Scenario, "id">) => { setScenarios([...scenarios, { ...x, id: uniqueId("scenario", scenarios) }]); setSel(scenarios.length); };
  const remove = (j: number) => { if (confirm(`Remove scenario "${scenarios[j].name}"?`)) setScenarios(scenarios.filter((_, k) => k !== j)); };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Scenario Lab" subtitle="What-if overlays applied on top of the base company">
        <Button onClick={() => add({ name: "New scenario", overlays: [] })} className="shadow-[0_0_18px_-4px_var(--primary)]"><Plus className="size-4" /> Add scenario</Button>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="flex flex-col gap-2">
          {scenarios.map((x, j) => (
            <Card key={j} size="sm"
              className={cn("transition-shadow hover:ring-primary/30", j === i && "ring-primary/50 shadow-[0_0_20px_-10px_var(--primary)]")}>
              <CardContent className="flex items-center gap-2">
                <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" aria-pressed={j === i} onClick={() => setSel(j)}>
                  <span className="block truncate font-medium">{x.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{x.id} · {x.overlays.length} overlay{x.overlays.length === 1 ? "" : "s"}</span>
                </button>
                {!x.overlays.length && <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-400 ring-1 ring-emerald-400/30">baseline</span>}
                <Button variant="ghost" size="icon" className="size-7" aria-label={`duplicate scenario ${x.id}`}
                  onClick={() => { add({ name: `${x.name} copy`, overlays: structuredClone(x.overlays) }); }}><Copy className="size-3.5" /></Button>
                <Button variant="ghost" size="icon" className="size-7" aria-label={`remove scenario ${x.id}`}
                  onClick={() => remove(j)}><Trash2 className="size-3.5" /></Button>
              </CardContent>
            </Card>
          ))}
          {!scenarios.length && <p className="text-sm text-muted-foreground">No scenarios yet.</p>}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {s && (
            <Card>
              <CardHeader>
                <div className="grid grid-cols-[12rem_1fr] gap-2">
                  {/* scenario ids stay unique: a clashing rename is ignored */}
                  <IdInput aria-label="scenario id" value={s.id} onCommit={(id) => id && !scenarios.some((y) => y.id === id) && setS({ ...s, id })} />
                  <Input aria-label="scenario name" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {s.overlays.map((o, k) => (
                  <OverlayEditor key={k} o={o} company={company}
                    onChange={(x) => setS({ ...s, overlays: s.overlays.map((y, m) => (m === k ? x : y)) })}
                    onRemove={() => setS({ ...s, overlays: s.overlays.filter((_, m) => m !== k) })} />
                ))}
                {!s.overlays.length && <p className="text-xs text-muted-foreground">No overlays: this scenario runs the base company unchanged.</p>}
                <Pick label="add overlay" value="" className="w-56" items={Object.fromEntries(OVERLAY_TYPES.map((t) => [t, `+ ${t}`]))}
                  onChange={(t) => setS({ ...s, overlays: [...s.overlays, newOverlay(t as (typeof OVERLAY_TYPES)[number], company)] })} />
              </CardContent>
            </Card>
          )}
          <OutagesCard company={company} onChange={setCompany} />
        </div>
      </div>
    </div>
  );
}

/** company.outages belong to the base company, so every scenario sees them. */
function OutagesCard({ company, onChange }: { company: Company; onChange: (c: Company) => void }) {
  const outages = company.outages ?? [];
  const set = (outs: typeof outages) => onChange({ ...company, outages: outs });
  return (
    <Card>
      <CardHeader><CardTitle>Planned outages</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {outages.map(([sys, start, end], k) => (
          <div key={k} className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/30 p-3 ring-1 ring-foreground/10">
            <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">System
              <Pick label={`system of outage ${k + 1}`} value={sys} items={systemItems(company)} onChange={(v) => set(outages.map((o, m) => (m === k ? [v, start, end] : o)))} />
            </label>
            <MinuteRange label={`outage ${k + 1}`} start={start} end={end} onChange={(a, b) => set(outages.map((o, m) => (m === k ? [sys, a, b] : o)))} />
            <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={`remove outage ${k + 1}`} onClick={() => set(outages.filter((_, m) => m !== k))}><Trash2 className="size-3.5" /></Button>
          </div>
        ))}
        {!outages.length && <p className="text-xs text-muted-foreground">No planned outages.</p>}
        <Button variant="outline" size="sm" className="self-start" disabled={!company.systems.length}
          onClick={() => set([...outages, [company.systems[0].id, 2 * DAY + 600, 2 * DAY + 720]])}><Plus className="size-4" /> Add outage</Button>
      </CardContent>
    </Card>
  );
}
