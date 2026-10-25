"use client";

import Link from "next/link";
import { ArrowRight, Boxes, Building2, Server, Users, UserRound } from "lucide-react";
import { IconTile, PageHeader, StatCard } from "@/components/page";
import { Panel } from "@/components/dashboard/kpi";
import { Chip, DeptMark, Loading, OrgNav, Pill, StatusDot, accent } from "@/components/org/parts";
import { allResources, deptHeadcount, isPool, stepsIn } from "@/components/org/ops";
import { Card, CardContent } from "@/components/ui/card";
import { headcount, referencedIds } from "@/lib/company";
import { useTwin } from "@/lib/store";

export default function OrganizationPage() {
  const { company } = useTwin();
  if (!company) return <Loading />;
  const resources = allResources(company);
  const steps = stepsIn(company);
  const sysRefs = referencedIds(company).systems;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Organization" subtitle={company.name} />
      <OrgNav />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {company.departments.map((d, i) => {
          const color = accent(i);
          const skills = Object.entries(d.resources.flatMap((r) => r.skills).reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {}))
            .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
          const pools = d.resources.filter(isPool).length;
          return (
            <Link key={i} href="/organization/departments" className="group rise rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              style={{ animationDelay: `${Math.min(i, 7) * 40}ms` }}>
              <Card className="h-full transition-shadow duration-200 group-hover:shadow-[0_0_0_1px_color-mix(in_oklch,var(--primary)_40%,transparent),0_0_28px_-10px_var(--primary)]"
                style={{ backgroundImage: `radial-gradient(circle at top right, color-mix(in oklch, ${color} 16%, transparent), transparent 60%)` }}>
                <CardContent className="flex h-full flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <DeptMark index={i} size="size-10" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{d.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{d.id}</div>
                    </div>
                    <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  <div>
                    <div className="text-3xl font-semibold tabular-nums leading-none tracking-tight">{deptHeadcount(company, d)}</div>
                    <div className="mt-1 text-xs text-muted-foreground tabular-nums">
                      headcount · {pools} pool{pools === 1 ? "" : "s"} · {d.resources.length - pools} people
                    </div>
                  </div>
                  <div className="mt-auto flex flex-wrap gap-1">
                    {skills.length ? skills.map((s) => <Chip key={s} color={color}>{s}</Chip>) : <span className="text-xs text-muted-foreground">no skills yet</span>}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard icon={Building2} label="Departments" value={company.departments.length} />
        <StatCard icon={Users} label="Total headcount" value={headcount(company)} />
        <StatCard icon={Boxes} label="Pools" value={resources.filter(isPool).length} />
        <StatCard icon={UserRound} label="Named people" value={resources.filter((r) => !isPool(r)).length} />
        <StatCard icon={Server} label="Systems" value={company.systems.length} />
      </div>
      <Panel title="Systems" subtitle="Shared tools the workflow steps run on" icon={Server} href="/organization/systems" linkLabel="Manage systems" contentClassName="flex flex-col gap-2">
        {company.systems.length === 0 && <span className="text-sm text-muted-foreground">No systems.</span>}
        {company.systems.map((s, i) => {
          const n = steps.filter((st) => st.system_id === s.id).length;
          return (
            <div key={i} className="flex items-center gap-3 rounded-xl p-2.5 glass-inset text-sm">
              <IconTile icon={Server} color="var(--chart-5)" />
              <div className="min-w-0">
                <div className="truncate">{s.name}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">{s.id}</div>
              </div>
              <span className="ml-auto flex items-center gap-2">
                <StatusDot ok={sysRefs.has(s.id)} title={sysRefs.has(s.id) ? "in use" : "unused"} />
                <Pill tone={n ? "primary" : "muted"}>used by {n} step{n === 1 ? "" : "s"}</Pill>
              </span>
            </div>
          );
        })}
      </Panel>
    </div>
  );
}
