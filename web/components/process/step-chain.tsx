import { Clock } from "lucide-react";
import { cn } from "cn";
import { accent } from "@/components/org/parts";
import { type Company, type Schedule, type Step, type Workflow, DAYS, durationMean } from "@/lib/company";

/** True when no resource in the step's department has its skill: the engine would queue it forever. */
export const unskilled = (c: Company, st: Step) =>
  !c.departments.find((d) => d.id === st.department_id)?.resources.some((r) => r.skills.includes(st.required_skill));

/** Sum of step means; null when any step has a duration kind without a simple mean. */
export function cycleMean(wf: Workflow): number | null {
  let sum = 0;
  for (const st of wf.steps) {
    const m = durationMean(st.duration);
    if (m === null) return null;
    sum += m;
  }
  return sum;
}

/** "Mon–Fri 9–17"; non-uniform hours list each day. */
export function windowSummary(s: Schedule): string {
  const days = Object.keys(s.weekday_hours).map(Number).sort((a, b) => a - b);
  if (!days.length) return "no arrival window";
  const hours = ([a, b]: [number, number]) => `${a}–${b}`;
  const [h0] = days.map((d) => s.weekday_hours[String(d)]);
  if (!days.every((d) => hours(s.weekday_hours[String(d)]) === hours(h0)))
    return days.map((d) => `${DAYS[d]} ${hours(s.weekday_hours[String(d)])}`).join(", ");
  const contiguous = days.length > 1 && days[days.length - 1] - days[0] === days.length - 1;
  return `${contiguous ? `${DAYS[days[0]]}–${DAYS[days[days.length - 1]]}` : days.map((d) => DAYS[d]).join(", ")} ${hours(h0)}`;
}

/** Numbered step circle filled with the department accent colour. */
export function StepNumber({ n, color, className }: { n: number; color: string; className?: string }) {
  return (
    <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white tabular-nums", className)}
      style={{ background: color, boxShadow: `0 0 12px -2px ${color}, inset 0 0 0 1px oklch(1 0 0 / 0.15)` }}>{n}</span>
  );
}

/** Process-flow strip: one numbered chip per step in list order, joined by a thin connector. */
export function StepChain({ wf, company, className }: { wf: Workflow; company: Company; className?: string }) {
  if (!wf.steps.length) return <p className={cn("text-xs text-muted-foreground", className)}>No steps yet.</p>;
  return (
    <ol className={cn("flex items-stretch overflow-x-auto pb-1", className)}>
      {wf.steps.map((st, i) => {
        const mean = durationMean(st.duration);
        const bad = unskilled(company, st);
        const di = company.departments.findIndex((d) => d.id === st.department_id);
        return (
          <li key={i} className="flex items-center">
            {i > 0 && <span aria-hidden className="h-px w-4 shrink-0 bg-gradient-to-r from-white/10 via-white/25 to-white/10" />}
            <div title={bad ? `no resource in ${st.department_id} has skill "${st.required_skill}"` : undefined}
              className={cn("flex h-full min-w-36 max-w-48 flex-col gap-2 rounded-xl p-3 glass-inset", bad && "shadow-[inset_0_0_0_1px_rgb(251_191_36/0.45)]")}>
              <span className="flex items-center justify-between gap-2">
                <StepNumber n={i + 1} color={di < 0 ? "oklch(0.5 0 0)" : accent(di)} />
                {bad && <span aria-label="no skilled resource" className="size-2 shrink-0 rounded-full bg-amber-400 shadow-[0_0_8px_#fbbf24]" />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-medium leading-tight">{st.name || st.id}</span>
                <span className="truncate text-xs text-muted-foreground">{st.department_id}</span>
                <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                  <Clock className="size-3" /> {mean === null ? "–" : `${mean.toFixed(1)} min`}
                </span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
