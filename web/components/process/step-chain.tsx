import { ChevronRight } from "lucide-react";
import { cn } from "cn";
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

/** Process-flow strip: one numbered chip per step in list order. */
export function StepChain({ wf, company, className }: { wf: Workflow; company: Company; className?: string }) {
  if (!wf.steps.length) return <p className={cn("text-xs text-muted-foreground", className)}>No steps yet.</p>;
  return (
    <ol className={cn("flex items-stretch gap-1 overflow-x-auto pb-1", className)}>
      {wf.steps.map((st, i) => {
        const mean = durationMean(st.duration);
        const bad = unskilled(company, st);
        return (
          <li key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-4 shrink-0 text-muted-foreground" />}
            <div title={bad ? `no resource in ${st.department_id} has skill "${st.required_skill}"` : undefined}
              className={cn("flex min-w-32 items-start gap-2 rounded-lg bg-muted/40 px-2.5 py-2 ring-1 ring-foreground/10", bad && "ring-amber-400/50")}>
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold text-primary ring-1 ring-primary/40">{i + 1}</span>
              <span className="flex min-w-0 flex-col">
                <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                  {st.name || st.id}
                  {bad && <span aria-label="no skilled resource" className="size-1.5 shrink-0 rounded-full bg-amber-400 shadow-[0_0_6px_#fbbf24]" />}
                </span>
                <span className="truncate text-[10px] text-muted-foreground">{st.department_id} · {mean === null ? "–" : `${mean.toFixed(1)} min`}</span>
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
