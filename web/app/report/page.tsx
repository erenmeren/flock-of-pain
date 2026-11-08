"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { Delta, KPI_LABEL, fmtKpi, sourceLabel } from "@/components/dashboard/kpi";
import { Interval, RecommendationList } from "@/components/dashboard/results";
import { fmt } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getRun } from "@/lib/api";
import { topWaits } from "@/lib/results";
import { type Config, useTwin } from "@/lib/store";

type Settings = { companyName?: string; config?: Partial<Config> };

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="text-base font-medium">{title}</h2>
    {children}
  </section>
);

export default function ReportPage() {
  const { company, result, resultSource } = useTwin();
  const historyId = resultSource?.kind === "history" ? resultSource.run_id : null;
  const [saved, setSaved] = useState<{ id: number; settings: Settings | null } | null>(null);
  // a history run has its own company and settings on the server; the draft's may be unrelated
  useEffect(() => {
    if (historyId === null) return;
    let stale = false;
    getRun(historyId).then(
      (r) => { if (!stale) setSaved({ id: historyId, settings: { companyName: (r.request.company as { name?: string }).name, config: r.request.config as Partial<Config> } }); },
      () => { if (!stale) setSaved({ id: historyId, settings: null }); },
    );
    return () => { stale = true; };
  }, [historyId]);

  const back = <Button variant="outline" size="sm" className="rounded-full print:hidden" render={<Link href="/analysis" />} nativeButton={false}><ArrowLeft className="size-3.5" /> Analysis</Button>;
  if (!result) return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-semibold">Report</h1>
      <p className="text-sm text-muted-foreground">No result to report. Run a simulation, or show a saved run on the Analysis page, then open the report from there.</p>
      {back}
    </div>
  );

  const history = historyId !== null;
  const settings: Settings | null = history ? (saved?.id === historyId ? saved.settings : null) : resultSource?.kind === "run" ? { companyName: resultSource.name, config: resultSource.config } : null;
  const c = settings?.config;
  const rows: [string, React.ReactNode][] = c ? [
    ["Days", c.days], ["Warm-up days", c.warmup_days ?? 0], ["Replications", c.replications], ["Seed", c.seed], ["Policy", c.policy], ["Common random numbers", c.crn ? "on" : "off"],
  ] : [];
  return (
    <article className="flex flex-col gap-6 p-2 text-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Simulation report</h1>
          <p className="text-muted-foreground">{settings?.companyName ?? resultSource?.name} · {sourceLabel(resultSource)}</p>
        </div>
        <span className="flex gap-2 print:hidden">
          {back}
          <Button size="sm" className="rounded-full" onClick={() => window.print()}><Printer className="size-3.5" /> Print</Button>
        </span>
      </div>

      <Section title="Run settings">
        {c ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
            {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}
          </dl>
        ) : <p className="text-muted-foreground">{history && saved?.id !== historyId ? "Loading the saved settings…" : "The saved settings could not be loaded."}</p>}
      </Section>

      <Section title="Assumptions">
        <p>{result.disclaimer}</p>
      </Section>

      <Section title="KPIs">
        <p className="text-xs text-muted-foreground">Mean with its 95% interval. A change against {result.scenarios[0]?.name} is marked significant when its own 95% interval excludes zero, and within noise otherwise.</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>KPI</TableHead>
              {result.scenarios.map((s) => <TableHead key={s.id} className="text-right">{s.name}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.kpi_keys.map((k) => (
              <TableRow key={k}>
                <TableCell>{KPI_LABEL[k] ?? k}</TableCell>
                {result.scenarios.map((s, i) => (
                  <TableCell key={s.id} className="text-right tabular-nums">
                    <div className="flex flex-col items-end">
                      <span className="font-medium">{fmtKpi(k, s.summary[k]?.mean)}</span>
                      <Interval k={k} st={s.summary[k]} />
                      {i > 0 && <span className="text-xs"><Delta k={k} value={s.summary[k]?.mean} base={result.scenarios[0].summary[k]?.mean} cmp={s.comparison?.[k]} /></span>}
                    </div>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      {result.scenarios.some((s) => s.recommendations) && (
        <Section title="Recommendations">
          {result.scenarios.filter((s) => s.recommendations).map((s) => (
            <div key={s.id} className="flex flex-col gap-2">
              <h3 className="font-medium">{s.name}</h3>
              <RecommendationList items={s.recommendations ?? []} company={company} />
            </div>
          ))}
        </Section>
      )}

      <Section title="Top waits">
        {result.scenarios.map((s) => (
          <div key={s.id} className="flex flex-col gap-1">
            <h3 className="font-medium">{s.name}</h3>
            {s.ledger.length === 0 ? <p className="text-muted-foreground">No blocked time.</p> : (
              <Table>
                <TableHeader><TableRow><TableHead>Department</TableHead><TableHead>Reason</TableHead><TableHead>Blocker</TableHead><TableHead className="text-right">Minutes</TableHead><TableHead className="text-right">Count</TableHead></TableRow></TableHeader>
                <TableBody>
                  {topWaits(s.ledger).map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>{company?.departments.find((d) => d.id === r.department_id)?.name ?? r.department_id}</TableCell>
                      <TableCell>{r.reason ?? ""}</TableCell>
                      <TableCell>{r.blocker_id ?? ""}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(r.minutes)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        ))}
      </Section>
    </article>
  );
}
