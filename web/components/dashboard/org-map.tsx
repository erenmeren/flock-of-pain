"use client";

import { useEffect, useRef, useState } from "react";
import { Server, Workflow } from "lucide-react";
import { DeptMark, accent } from "@/components/org/parts";
import { deptHeadcount } from "@/components/org/ops";
import type { Company } from "@/lib/company";
import { fmt } from "@/components/page";
import { type Edge, mapEdges } from "@/components/dashboard/derive";

type Box = { x: number; y: number; w: number; h: number };

/** Workflows on the left, departments in the middle, systems on the right; SVG curves show where work flows. */
export function OrgMap({ company }: { company: Company }) {
  const root = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const next: Record<string, Box> = {};
      el.querySelectorAll<HTMLElement>("[data-node]").forEach((n) => {
        const r = n.getBoundingClientRect();
        next[n.dataset.node!] = { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height };
      });
      setBoxes(next);
    };
    const ro = new ResizeObserver(measure); // fires once on observe, then on every size change
    ro.observe(el);
    return () => ro.disconnect();
  }, [company]);

  const edges = mapEdges(company);
  const color = (e: Edge) => (e.dept === null ? "var(--primary)" : accent(e.dept));
  const path = (e: Edge) => {
    const a = boxes[e.from], b = boxes[e.to];
    if (!a || !b) return null;
    const vertical = Math.abs(a.x - b.x) < 8; // same column: curve out to the side
    const x1 = vertical ? a.x + a.w / 2 : a.x + a.w, y1 = a.y + a.h / 2, x2 = vertical ? b.x + b.w / 2 : b.x, y2 = b.y + b.h / 2;
    const d = vertical ? `M ${x1} ${y1} C ${x1 + 40} ${y1}, ${x2 + 40} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
    return { d, mid: vertical ? { x: x1 + 30, y: (y1 + y2) / 2 } : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 } };
  };

  return (
    <div ref={root} className="relative grid grid-cols-[8.5rem_1fr_7.5rem] gap-x-6">
      <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
        {edges.map((e) => {
          const p = path(e);
          return p && (
            <g key={`${e.from}>${e.to}`}>
              <path d={p.d} fill="none" stroke={color(e)} strokeOpacity="0.45" strokeWidth={Math.min(4, 1 + e.n * 0.6)} strokeLinecap="round" />
              <circle cx={p.mid.x} cy={p.mid.y} r="3" fill={color(e)} style={{ filter: `drop-shadow(0 0 4px ${color(e)})` }} />
            </g>
          );
        })}
      </svg>
      <Column title="Inflows">
        {company.workflows.map((w) => (
          <div key={w.id} data-node={`w:${w.id}`} className="glass-inset relative flex items-center gap-2 rounded-xl px-2.5 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary"><Workflow className="size-3.5" /></span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium" title={w.name}>{w.name}</span>
              <span className="block text-[10px] tabular-nums text-muted-foreground">{fmt(w.arrival.rate_per_hour, 1)}/h</span>
            </span>
          </div>
        ))}
        {!company.workflows.length && <Empty>No workflows</Empty>}
      </Column>
      <div className="grid grid-cols-2 content-center gap-x-3 gap-y-4 py-1">
        {company.departments.map((d, i) => (
          <div key={d.id} data-node={`d:${d.id}`} className="glass-inset relative flex items-center gap-2.5 rounded-2xl p-2 pr-3"
            style={{ boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${accent(i)} 35%, transparent), 0 12px 30px -20px ${accent(i)}` }}>
            <DeptMark index={i} size="size-8" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium" title={d.id}>{d.name}</span>
              <span className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />{deptHeadcount(company, d)}
              </span>
            </span>
          </div>
        ))}
        {!company.departments.length && <Empty>No departments</Empty>}
      </div>
      <Column title="Systems">
        {company.systems.map((s) => (
          <div key={s.id} data-node={`s:${s.id}`} className="glass-inset relative flex items-center gap-2 rounded-xl px-2.5 py-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-foreground/80"><Server className="size-3.5" /></span>
            <span className="truncate text-xs font-medium" title={s.id}>{s.name}</span>
          </div>
        ))}
        {!company.systems.length && <Empty>No systems</Empty>}
      </Column>
    </div>
  );
}

const Column = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-2 self-center">
    <span className="px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{title}</span>
    {children}
  </div>
);
const Empty = ({ children }: { children: React.ReactNode }) => <span className="px-1 text-xs text-muted-foreground">{children}</span>;
