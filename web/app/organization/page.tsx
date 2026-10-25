"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { PageHeader, StatCard } from "@/components/page";
import { Chip, Loading, ORG_LINKS, OrgNav, StatusDot, accent } from "@/components/org/parts";
import { allResources, deptHeadcount, isPool, stepsIn } from "@/components/org/ops";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
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
      <PageHeader title="Organization" subtitle={company.name}>
        {ORG_LINKS.slice(1).map(({ href, label, icon: Icon }) => (
          <Link key={href} href={href} className={buttonVariants({ variant: "outline", size: "sm" })}><Icon /> {label}</Link>
        ))}
      </PageHeader>
      <OrgNav />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Departments" value={company.departments.length} />
        <StatCard label="Total headcount" value={headcount(company)} />
        <StatCard label="Pools" value={resources.filter(isPool).length} />
        <StatCard label="Named people" value={resources.filter((r) => !isPool(r)).length} />
        <StatCard label="Systems" value={company.systems.length} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {company.departments.map((d, i) => {
          const color = accent(i);
          const skills = Object.entries(d.resources.flatMap((r) => r.skills).reduce<Record<string, number>>((m, s) => ({ ...m, [s]: (m[s] ?? 0) + 1 }), {}))
            .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s]) => s);
          return (
            <Link key={i} href="/organization/departments" className="group rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60">
              <Card className="h-full transition-shadow group-hover:ring-primary/40 group-hover:shadow-[0_0_24px_-8px_var(--primary)]"
                style={{ backgroundImage: `radial-gradient(circle at top right, color-mix(in oklch, ${color} 18%, transparent), transparent 60%)` }}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                    {d.name}
                    <ArrowRight className="ml-auto size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </CardTitle>
                  <span className="font-mono text-xs text-muted-foreground">{d.id}</span>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="grid grid-cols-3 gap-2">
                    <Metric label="Headcount" value={deptHeadcount(company, d)} />
                    <Metric label="Pools" value={d.resources.filter(isPool).length} />
                    <Metric label="People" value={d.resources.filter((r) => !isPool(r)).length} />
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {skills.length ? skills.map((s) => <Chip key={s} color={color}>{s}</Chip>) : <span className="text-xs text-muted-foreground">no skills yet</span>}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Systems</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col divide-y divide-foreground/10">
          {company.systems.length === 0 && <span className="text-sm text-muted-foreground">No systems.</span>}
          {company.systems.map((s, i) => {
            const n = steps.filter((st) => st.system_id === s.id).length;
            return (
              <div key={i} className="flex items-center gap-3 py-2 text-sm">
                <StatusDot ok={sysRefs.has(s.id)} title={sysRefs.has(s.id) ? "in use" : "unused"} />
                <span>{s.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">used by {n} step{n === 1 ? "" : "s"}</span>
              </div>
            );
          })}
          <Link href="/organization/systems" className={buttonVariants({ variant: "link", size: "sm", className: "mt-2 self-start px-0" })}>Manage systems</Link>
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
