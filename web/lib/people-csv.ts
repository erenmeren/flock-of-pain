// Pure People CSV import: text to a previewable plan, plan to a merged Company. Cell text is only ever data.
import { type Loc, addResource, isPool, movePerson, setResource } from "@/components/org/ops";
import { type Company, type Hours, type Resource, type Schedule, slug, weekdays9to5 } from "@/lib/company";

export const MAX_ROWS = 5000;
const REQUIRED = ["name", "department", "skills"];
const KNOWN = [...REQUIRED, "id", "start", "end", "days", "cost_per_hour", "speed_factor", "overtime_rate"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

type Table = { rows: { line: number; cells: string[] }[]; open: number | null }; // open = line of a quote never closed

/** The delimiter of the first line with content: comma, semicolon or tab, whichever occurs most outside quotes. */
function sniff(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false, seen = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) { if (seen) break; }
    else if (!quoted && ch in counts) { counts[ch]++; seen = true; }
    else if (ch.trim()) seen = true;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
}

/** RFC 4180 style: quotes anywhere a cell starts, "" inside them, CRLF, CR or LF; blank rows dropped, cells trimmed. */
export function parseTable(text: string): Table {
  const src = text.replace(/^﻿/, "");
  const delim = sniff(src);
  const rows: Table["rows"] = [];
  let cells: string[] = [], cell = "", quoted = false, line = 1, rowLine = 1, quoteLine = 1;
  const endCell = () => { cells.push(cell.trim()); cell = ""; };
  const endRow = () => {
    endCell();
    if (cells.some(Boolean)) rows.push({ line: rowLine, cells });
    cells = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line++;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell.trim()) { cell = ""; quoted = true; quoteLine = line; }
    else if (ch === delim) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") { i++; line++; }
      endRow();
      rowLine = line;
    } else cell += ch;
  }
  if (quoted) return { rows, open: quoteLine };
  endRow();
  return { rows, open: null };
}

/** "Mon-Fri", "0-4", "Mon,Wed", "Sat", "Fri-Mon" (wraps round the week) as sorted weekday numbers; null when a part is unknown. */
export function parseDays(text: string): number[] | null {
  const one = (t: string) => {
    if (/^[0-6]$/.test(t)) return Number(t);
    const d = WEEKDAYS.findIndex((w) => w === t || w.slice(0, 3) === t);
    return d < 0 ? null : d;
  };
  const out = new Set<number>();
  const parts = text.toLowerCase().replace(/\s*[-–]\s*/g, "-").split(/[,;/\s]+/).filter(Boolean);
  for (const part of parts) {
    const ends = part.split(/[-–]/).map(one);
    if (ends.length > 2 || ends.includes(null)) return null;
    for (let d = ends[0] as number; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === ends[ends.length - 1]) break;
    }
  }
  return parts.length ? [...out].sort((a, b) => a - b) : null;
}

export type PersonRow = {
  line: number;
  name: string;
  id: string; // "" only when the row has no usable id
  department: string; // as typed
  deptId: string;
  deptName: string;
  newDept: boolean;
  status: "new" | "existing" | "error";
  errors: string[];
  fields: Partial<Pick<Resource, "skills" | "cost_per_hour" | "speed_factor" | "overtime_rate" | "schedule">>; // only the cells that were filled
};
export type PeoplePlan = { error: string | null; warnings: string[]; rows: PersonRow[] };
export type ExistingChoice = "update" | "skip";
export type PeopleOptions = { createMissing?: boolean; reserved?: Iterable<string> }; // reserved: ids that scenario overlays add

const fail = (error: string, warnings: string[] = []): PeoplePlan => ({ error, warnings, rows: [] });

/** A number cell; undefined when empty. Excel's decimal comma ("12,5") is read, but "1,000" is refused rather than guessed. */
function numberCell(text: string, label: string, errors: string[], ok: (n: number) => boolean, rule: string): number | undefined {
  if (!text) return undefined;
  const t = /^\d+,\d{1,2}$/.test(text) ? text.replace(",", ".") : text;
  const n = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(n)) errors.push(`${label}: "${text}" is not a number`);
  else if (!ok(n)) errors.push(`${label}: ${rule}, got ${text}`);
  else return n;
  return undefined;
}

/** An hour cell: a number or HH:MM (14:30 = 14.5). */
function hourCell(text: string, label: string, errors: string[], ok: (n: number) => boolean, rule: string): number | undefined {
  const hm = /^(\d{1,2}):([0-5]\d)$/.exec(text);
  return numberCell(hm ? String(Number(hm[1]) + Number(hm[2]) / 60) : text, label, errors, ok, rule);
}

export function parsePeopleCsv(text: string, company: Company, opts: PeopleOptions = {}): PeoplePlan {
  const table = parseTable(text);
  const warnings = text.includes("�") ? ["Some characters could not be read: save the file as \"CSV UTF-8\" in Excel."] : [];
  if (table.open !== null) return fail(`A quoted cell starting on line ${table.open} is never closed.`, warnings);
  const [head, ...data] = table.rows;
  if (!head) return fail("The file is empty: a header row is required.", warnings);
  const headers = head.cells.map((h) => h.toLowerCase().replace(/\s+/g, "_"));
  const missing = REQUIRED.filter((h) => !headers.includes(h));
  if (missing.length) return fail(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. The first row must name the columns.`, warnings);
  const twice = headers.find((h, i) => h && headers.indexOf(h) !== i);
  if (twice) return fail(`Column "${twice}" appears twice.`, warnings);
  const unknown = headers.filter((h) => h && !KNOWN.includes(h));
  if (unknown.length) warnings.push(`Ignored column${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}.`);
  if (data.length > MAX_ROWS) return fail(`The file has ${data.length} rows; at most ${MAX_ROWS} can be imported at once. Split it into smaller files.`, warnings);

  const everyone = company.departments.flatMap((d) => d.resources);
  const people = new Set(everyone.filter((r) => !isPool(r)).map((r) => r.id));
  const pools = new Set(everyone.filter(isPool).map((r) => r.id));
  const reserved = new Set(opts.reserved ?? []);
  const seen = new Map<string, number>(); // id -> line that claimed it in this file
  const blocked = (id: string) => seen.has(id) || pools.has(id) || reserved.has(id);

  const depts = new Map<string, { id: string; name: string; isNew: boolean }>(); // ids win over names, case-insensitive
  for (const d of company.departments) depts.set(d.id.toLowerCase(), { ...d, isNew: false });
  for (const d of company.departments) if (!depts.has(d.name.toLowerCase())) depts.set(d.name.toLowerCase(), { ...d, isNew: false });
  const deptIds = new Set(company.departments.map((d) => d.id));

  const rows = data.map(({ line, cells }): PersonRow => {
    const cell = (h: string) => { const i = headers.indexOf(h); return i < 0 ? "" : cells[i] ?? ""; };
    const errors: string[] = [];
    if (cells.length > headers.length) errors.push(`${cells.length} cells but ${headers.length} columns: put quotes round a value that contains the delimiter`);
    const name = cell("name"), department = cell("department");
    if (!name) errors.push("name is empty");

    let dept = depts.get(department.toLowerCase());
    if (!department) errors.push("department is empty");
    else if (!dept && opts.createMissing) {
      const stem = slug(department) || "dept";
      let id = stem;
      for (let n = 2; deptIds.has(id); n++) id = `${stem}_${n}`;
      deptIds.add(id);
      dept = { id, name: department, isNew: true };
      depts.set(department.toLowerCase(), dept);
    } else if (!dept) errors.push(`unknown department "${department}": tick Create missing departments to add it`);

    const fields: PersonRow["fields"] = {};
    const skills = cell("skills");
    if (skills) fields.skills = [...new Set(skills.split(";").map((s) => s.trim()).filter(Boolean))];
    const cost = numberCell(cell("cost_per_hour"), "cost_per_hour", errors, (n) => n >= 0, "must not be negative");
    if (cost !== undefined) fields.cost_per_hour = cost;
    const speed = numberCell(cell("speed_factor"), "speed_factor", errors, (n) => n > 0, "must be above 0");
    if (speed !== undefined) fields.speed_factor = speed;
    const overtime = numberCell(cell("overtime_rate"), "overtime_rate", errors, (n) => n >= 1, "must be 1 or more (1.5 = time and a half)");
    if (overtime !== undefined) fields.overtime_rate = overtime;

    const [s, e, dayText] = [cell("start"), cell("end"), cell("days")];
    if (s || e || dayText) {
      const start = s ? hourCell(s, "start", errors, (n) => n >= 0 && n < 24, "must be an hour from 0 to under 24") : 9;
      const end = start === undefined ? undefined : e ? hourCell(e, "end", errors, (n) => n > start && n <= start + 24, `must be after ${start} and at most ${start + 24} (overnight: end past 24)`) : 17;
      if (start !== undefined && end !== undefined && end <= start) errors.push(`end: must be after ${start}, got the default 17`);
      const days = dayText ? parseDays(dayText) : [0, 1, 2, 3, 4];
      if (!days) errors.push(`days: "${dayText}" is not like Mon-Fri or 0-4`);
      if (start !== undefined && end !== undefined && days) fields.schedule = { weekday_hours: Object.fromEntries(days.map((d) => [String(d), [start, end] as Hours])) };
    }

    let id = "";
    const rawId = cell("id");
    if (rawId) {
      id = people.has(rawId) || blocked(rawId) ? rawId : slug(rawId);
      if (!id) errors.push(`id "${rawId}" has no letters or digits`);
      else if (seen.has(id)) errors.push(`id ${id} is already used on line ${seen.get(id)}`);
      else if (pools.has(id)) errors.push(`id ${id} belongs to a pool`);
      else if (reserved.has(id)) errors.push(`id ${id} is added by a scenario`);
    } else if (name) {
      const stem = slug(name) || "emp";
      id = stem;
      for (let n = 2; blocked(id); n++) id = `${stem}_${n}`;
    }
    if (id && !seen.has(id)) seen.set(id, line);

    return { line, name, id, department, deptId: dept?.id ?? "", deptName: dept?.name ?? "", newDept: !!dept?.isNew, errors, fields, status: errors.length ? "error" : people.has(id) ? "existing" : "new" };
  });
  return { error: null, warnings, rows };
}

/** The rows that take effect under this choice. */
export const importedRows = (plan: PeoplePlan, onExisting: ExistingChoice) => plan.rows.filter((r) => r.status === "new" || (r.status === "existing" && onExisting === "update"));

function locate(c: Company, id: string): Loc | null {
  for (let di = 0; di < c.departments.length; di++) {
    const ri = c.departments[di].resources.findIndex((r) => r.id === id && !isPool(r));
    if (ri >= 0) return { di, ri };
  }
  return null;
}

/** New people stand alone; an update changes only the filled cells and keeps the person's absences. Departments appear only for rows that import. */
export function applyPeople(c: Company, plan: PeoplePlan, onExisting: ExistingChoice): Company {
  let out = c;
  for (const row of importedRows(plan, onExisting)) {
    let di = out.departments.findIndex((d) => d.id === row.deptId);
    if (di < 0) {
      di = out.departments.length;
      out = { ...out, departments: [...out.departments, { id: row.deptId, name: row.deptName, resources: [] }] };
    }
    let loc = row.status === "existing" ? locate(out, row.id) : null;
    if (!loc) {
      out = addResource(out, di, { id: row.id, name: row.name, skills: [], cost_per_hour: 0, schedule: weekdays9to5(), ...row.fields });
      continue;
    }
    if (loc.di !== di) {
      out = movePerson(out, loc, di);
      loc = { di, ri: out.departments[di].resources.length - 1 };
    }
    const old = out.departments[loc.di].resources[loc.ri];
    const absences = old.schedule?.absences;
    const schedule: Schedule | null | undefined = row.fields.schedule && absences ? { ...row.fields.schedule, absences } : row.fields.schedule;
    out = setResource(out, loc, { ...old, name: row.name, ...row.fields, schedule: schedule ?? old.schedule });
  }
  return out;
}
