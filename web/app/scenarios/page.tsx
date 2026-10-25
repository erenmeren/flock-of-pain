"use client";

import { useState } from "react";
import { Clock, Copy, FlaskConical, Layers, Plus, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/dashboard/kpi";
import { Pill, accent } from "@/components/org/parts";
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
      <div className="grid items-start gap-4 lg:grid-cols-[22rem_1fr]">
        <Panel title="Scenarios" subtitle={`${scenarios.length} what-if variant${scenarios.length === 1 ? "" : "s"}`} icon={Layers} contentClassName="flex flex-col gap-2">
          {scenarios.map((x, j) => (
            <div key={j} className={cn("flex items-center gap-2 rounded-xl p-2.5 glass-inset transition-shadow duration-200 hover:shadow-[inset_0_0_0_1px_oklch(1_0_0/0.14)]",
              j === i && "shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_60%,transparent),0_0_20px_-8px_var(--primary)]! bg-primary/10")}>
              <span className="size-2.5 shrink-0 rounded-full" style={{ background: accent(j), boxShadow: `0 0 8px ${accent(j)}` }} />
              <button type="button" className="min-w-0 flex-1 cursor-pointer text-left" aria-pressed={j === i} onClick={() => setSel(j)}>
                <span className="block truncate text-sm font-medium">{x.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">{x.id}</span>
              </button>
              {x.overlays.length ? <Pill>{x.overlays.length} change{x.overlays.length === 1 ? "" : "s"}</Pill> : <Pill tone="green">baseline</Pill>}
              <Button variant="ghost" size="icon" className="size-7" aria-label={`duplicate scenario ${x.id}`}
                onClick={() => { add({ name: `${x.name} copy`, overlays: structuredClone(x.overlays) }); }}><Copy className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-7" aria-label={`remove scenario ${x.id}`}
                onClick={() => remove(j)}><Trash2 className="size-3.5" /></Button>
            </div>
          ))}
          {!scenarios.length && <p className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted-foreground">No scenarios yet.</p>}
        </Panel>
        <div className="flex min-w-0 flex-col gap-4">
          {s && (
            <Panel title={s.name || s.id} subtitle={`${s.overlays.length} overlay${s.overlays.length === 1 ? "" : "s"} on top of the base company`} icon={FlaskConical}
              action={<Pick label="add overlay" value="" placeholder="+ Add overlay" className="w-52 rounded-full data-placeholder:text-foreground" items={Object.fromEntries(OVERLAY_TYPES.map((t) => [t, `+ ${t}`]))}
                onChange={(t) => setS({ ...s, overlays: [...s.overlays, newOverlay(t as (typeof OVERLAY_TYPES)[number], company)] })} />}
              contentClassName="flex flex-col gap-3">
              <div className="grid gap-3 rounded-xl p-3 glass-inset sm:grid-cols-[12rem_1fr]">
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">Id
                  {/* scenario ids stay unique: a clashing rename is ignored */}
                  <IdInput aria-label="scenario id" className="font-mono normal-case tracking-normal" value={s.id} onCommit={(id) => id && !scenarios.some((y) => y.id === id) && setS({ ...s, id })} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">Name
                  <Input aria-label="scenario name" className="normal-case tracking-normal" value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
                </label>
              </div>
              {s.overlays.map((o, k) => (
                <OverlayEditor key={k} o={o} company={company}
                  onChange={(x) => setS({ ...s, overlays: s.overlays.map((y, m) => (m === k ? x : y)) })}
                  onRemove={() => setS({ ...s, overlays: s.overlays.filter((_, m) => m !== k) })} />
              ))}
              {!s.overlays.length && <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted-foreground">No overlays: this scenario runs the base company unchanged.</p>}
            </Panel>
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
    <Panel title="Planned outages" subtitle="Base company downtime every scenario sees" icon={Clock} contentClassName="flex flex-col gap-2"
      action={<Button variant="outline" size="sm" className="rounded-full" disabled={!company.systems.length}
        onClick={() => set([...outages, [company.systems[0].id, 2 * DAY + 600, 2 * DAY + 720]])}><Plus className="size-4" /> Add outage</Button>}>
        {outages.map(([sys, start, end], k) => (
          <div key={k} className="flex flex-wrap items-end gap-3 rounded-xl p-3 glass-inset">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-muted-foreground">System
              <Pick label={`system of outage ${k + 1}`} value={sys} items={systemItems(company)} onChange={(v) => set(outages.map((o, m) => (m === k ? [v, start, end] : o)))} />
            </label>
            <MinuteRange label={`outage ${k + 1}`} start={start} end={end} onChange={(a, b) => set(outages.map((o, m) => (m === k ? [sys, a, b] : o)))} />
            <Button variant="ghost" size="icon" className="ml-auto size-7" aria-label={`remove outage ${k + 1}`} onClick={() => set(outages.filter((_, m) => m !== k))}><Trash2 className="size-3.5" /></Button>
          </div>
        ))}
        {!outages.length && <p className="rounded-xl border border-dashed border-border py-6 text-center text-xs text-muted-foreground">No planned outages.</p>}
    </Panel>
  );
}
