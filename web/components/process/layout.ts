import { type Pos, type Workflow } from "@/lib/company";
import { inflowsOf, reachable } from "@/components/process/graph";

export const COL = 256;
export const ROW = 112;

/** Left-to-right layout: inflows in column 0, each step one column after its latest predecessor, unreachable steps after the last column. */
export function autoLayout(wf: Workflow): Record<string, Pos> {
  const inflows = inflowsOf(wf);
  const reach = reachable(wf);
  const col = new Map<string, number>();
  const colOf = (id: string, seen: string[] = []): number => {
    const known = col.get(id);
    if (known !== undefined) return known;
    if (seen.includes(id)) return 0; // a cycle in a draft: stop descending
    const preds = [...wf.steps.filter((s) => reach.has(s.id) && (wf.steps.find((t) => t.id === id)?.depends_on ?? []).includes(s.id)).map((s) => colOf(s.id, [...seen, id])),
      ...inflows.filter((i) => i.entry.includes(id)).map(() => 0)];
    const n = 1 + Math.max(0, ...preds);
    col.set(id, n);
    return n;
  };
  for (const s of wf.steps) if (reach.has(s.id)) colOf(s.id);
  const after = Math.max(0, ...col.values()) + 1;
  const rows = new Map<number, number>();
  const out: Record<string, Pos> = {};
  const place = (id: string, x: number) => { const r = rows.get(x) ?? 0; rows.set(x, r + 1); out[id] = [x * COL, r * ROW]; };
  for (const i of inflows) place(i.id, 0);
  for (const s of wf.steps) place(s.id, reach.has(s.id) ? col.get(s.id)! : after);
  return out;
}

/** Stored positions, with auto layout filling any id that has none. */
export function fillLayout(wf: Workflow): Record<string, Pos> {
  return { ...autoLayout(wf), ...wf.layout };
}
