// Pure logic over a simulation result: CSV export, reality check, top waits.
import type { Comparison, LedgerRow, SimulateResponse, Stat } from "@/lib/api";
import type { Company } from "@/lib/company";

/** `negligible`: significant, but too small to show as non-zero (see `deltaShown`). */
export const noiseLabel = (c: Comparison, negligible = false) => (!c.significant ? "within noise" : negligible ? "negligible" : "significant");

/** Change vs baseline as shown: percentage points when `pct`, relative % otherwise (null when the base is 0).
 * A change that rounds to zero at `digits` gets up to 2 more decimals; still zero there, it is `negligible` and shown as 0. */
export function deltaShown(value: number, base: number, pct: boolean, digits = 1): { d: number; text: string; negligible: boolean } | null {
  const d = pct ? (value - base) * 100 : base === 0 ? null : ((value - base) / Math.abs(base)) * 100;
  if (d === null) return null;
  let n = digits;
  while (n < digits + 2 && Number(d.toFixed(n)) === 0) n++;
  const negligible = Number(d.toFixed(n)) === 0;
  return { d, text: negligible ? (0).toFixed(digits) : `${d > 0 ? "+" : ""}${d.toFixed(n)}`, negligible };
}

/** "," for plain CSV; ";" for Excel in locales with a decimal comma (Turkish, German), which then also writes numbers with a comma. */
export type CsvSep = "," | ";";

/** A text cell: a spreadsheet must not run it as a formula, and separators stay inside quotes. */
export function csvText(s: string, sep: CsvSep = ","): string {
  const safe = /^\s*[=+\-@]|^[\t\r\n]/.test(s) ? `'${s}` : s;
  return /["\r\n]/.test(safe) || safe.includes(sep) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const csvNum = (n: number | null | undefined, sep: CsvSep) => (typeof n === "number" && Number.isFinite(n) ? (sep === ";" ? String(n).replace(".", ",") : String(n)) : "");

/** One row per scenario and KPI; values are as the API sends them, so rates are fractions. Missing data leaves its cell empty. */
export function resultsCsv(r: SimulateResponse, sep: CsvSep = ","): string {
  const rows = [["scenario", "kpi", "mean", "ci_low", "ci_high", "p10", "p50", "p90", "delta", "significant"].join(sep)];
  for (const s of r.scenarios) for (const k of r.kpi_keys) {
    const st: Partial<Stat> = s.summary[k] ?? {};
    const c = s.comparison?.[k];
    rows.push([csvText(s.name, sep), csvText(k, sep), ...[st.mean, st.ci_low, st.ci_high, st.p10, st.p50, st.p90, c?.delta].map((n) => csvNum(n, sep)), c ? String(c.significant) : ""].join(sep));
  }
  return rows.join("\r\n") + "\r\n";
}

export type RealityRow = { kpi: string; actual?: number; stat?: Stat; diff?: number; verdict?: "inside" | "outside" };

/** Simulated against observed per KPI. No verdict without an observed value, or with no interval to test against (an old run, one replication). */
export function realityRows(kpis: string[], summary: Record<string, Stat>, actuals: Record<string, number> | undefined): RealityRow[] {
  return kpis.map((kpi) => {
    const actual = actuals?.[kpi], stat = summary[kpi];
    if (actual === undefined || !stat) return { kpi, actual, stat };
    const { ci_low: low, ci_high: high } = stat;
    const tested = typeof low === "number" && typeof high === "number" && low !== high;
    return { kpi, actual, stat, diff: stat.mean - actual, ...(tested ? { verdict: actual >= low && actual <= high ? "inside" as const : "outside" as const } : {}) };
  });
}

/** The company with one observed value set, or removed when undefined; no empty `actuals` is left behind. */
export function setActual(c: Company, kpi: string, value: number | undefined): Company {
  const actuals = { ...c.actuals };
  if (value === undefined) delete actuals[kpi]; else actuals[kpi] = value;
  const out: Company = { ...c, actuals };
  if (!Object.keys(actuals).length) delete out.actuals;
  return out;
}

export const topWaits = (ledger: LedgerRow[], n = 5): LedgerRow[] => [...ledger].sort((a, b) => b.minutes - a.minutes).slice(0, n);
