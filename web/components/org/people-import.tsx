"use client";

import { useMemo, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "cn";
import { Panel } from "@/components/dashboard/kpi";
import { Pick } from "@/components/editor-fields";
import { Hint } from "@/components/hint";
import { Pill, TABLE_STYLE } from "@/components/org/parts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { Company, Scenario } from "@/lib/company";
import { type ExistingChoice, MAX_ROWS, applyPeople, importedRows, parsePeopleCsv } from "@/lib/people-csv";

const MAX_FILE_MB = 10;
const SHOWN = 500; // table rows drawn; errors come first so none is hidden by a long file

export function PeopleImport({ company, scenarios, setCompany }: { company: Company; scenarios: Scenario[]; setCompany: (c: Company) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [createMissing, setCreateMissing] = useState(false);
  const [onExisting, setOnExisting] = useState<ExistingChoice>("skip");
  const [note, setNote] = useState("");
  const plan = useMemo(() => (text.trim() ? parsePeopleCsv(text, company, {
    createMissing,
    reserved: scenarios.flatMap((s) => s.overlays).flatMap((o) => (o.type === "add_employee" ? [o.employee.id] : [])),
  }) : null), [text, company, scenarios, createMissing]);
  const importing = plan ? importedRows(plan, onExisting) : [];
  const errors = plan?.rows.filter((r) => r.status === "error") ?? [];
  const existing = plan?.rows.filter((r) => r.status === "existing") ?? [];
  const rows = plan ? [...errors, ...plan.rows.filter((r) => r.status !== "error")].slice(0, SHOWN) : [];

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_FILE_MB * 1024 * 1024) { setNote(`That file is over ${MAX_FILE_MB} MB; at most ${MAX_ROWS} rows can be imported.`); return; }
    setNote("");
    setText(await f.text());
  };

  return (
    <Panel title={<span className="flex items-center gap-1">Import people from CSV<Hint id="people_csv" /></span>} subtitle="Nothing changes until you press Import" icon={Upload}>
      <div className={cn("flex flex-col gap-3", TABLE_STYLE)}>
        <p className="text-xs text-muted-foreground">
          A header row is required. Columns: <code>name, department, skills</code> (separated by <code>;</code>), and optionally <code>id, start, end, days, cost_per_hour, speed_factor, overtime_rate</code>.
          Comma, semicolon or tab delimited. No hours given means Mon-Fri 9-17.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv" hidden aria-label="people csv file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void pick(f); }} />
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => fileRef.current?.click()}>Choose file…</Button>
          <Label className="flex items-center gap-2 text-sm font-normal">
            <Checkbox aria-label="create missing departments" checked={createMissing} onCheckedChange={(c) => setCreateMissing(!!c)} /> Create missing departments
          </Label>
          {text && <Button variant="outline" size="sm" className="rounded-full" onClick={() => { setText(""); setNote(""); }}>Clear</Button>}
        </div>
        <Textarea aria-label="people csv text" className="max-h-48 font-mono text-xs" spellCheck={false} placeholder={"name,department,skills\nAyse Kaya,Sales,quote;order"} value={text} onChange={(e) => { setText(e.target.value); setNote(""); }} />
        {note && <p className="text-sm text-muted-foreground" role="status">{note}</p>}
        {plan?.error && <p className="text-sm text-rose-400" role="alert">{plan.error}</p>}
        {plan?.warnings.map((w) => <p key={w} className="text-xs text-amber-400">{w}</p>)}
        {plan && !plan.error && (plan.rows.length === 0 ? <p className="text-sm text-muted-foreground">No rows under the header.</p> : <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Button className="rounded-full" disabled={!importing.length} onClick={() => {
              setCompany(applyPeople(company, plan, onExisting));
              setText("");
              setNote(`Imported ${importing.length} ${importing.length === 1 ? "person" : "people"}.`);
            }}>Import {importing.length} {importing.length === 1 ? "person" : "people"}</Button>
            {errors.length > 0 && <span className="text-rose-400">{errors.length} {errors.length === 1 ? "row has errors" : "rows have errors"} and will not be imported</span>}
            {existing.length > 0 && (
              <span className="flex items-center gap-2">
                {existing.length} already {existing.length === 1 ? "exists" : "exist"}:
                <Pick label="people that already exist" className="w-52" value={onExisting} items={{ skip: "Skip them", update: "Update them from the file" }} onChange={(v) => setOnExisting(v as ExistingChoice)} />
              </span>
            )}
          </div>
          <div className="max-h-96 overflow-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Line</TableHead><TableHead>Name</TableHead><TableHead>Id</TableHead><TableHead>Department</TableHead><TableHead>Skills</TableHead><TableHead>Result</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.line}>
                    <TableCell className="tabular-nums text-muted-foreground">{r.line}</TableCell>
                    <TableCell>{r.name}</TableCell>
                    <TableCell className="font-mono text-xs">{r.id}</TableCell>
                    <TableCell>{r.deptName || r.department}{r.newDept && <span className="ml-2"><Pill>new</Pill></span>}</TableCell>
                    <TableCell className="max-w-48 truncate text-xs">{r.fields.skills?.join(", ")}</TableCell>
                    <TableCell className="whitespace-normal">
                      {r.status === "error" ? <span className="text-xs text-rose-400">{r.errors.join("; ")}</span>
                        : r.status === "new" ? <Pill tone="green">new</Pill>
                        : <Pill tone={onExisting === "update" ? "primary" : "muted"}>{onExisting === "update" ? "update" : "skip"}</Pill>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {plan.rows.length > SHOWN && <p className="text-xs text-muted-foreground">Showing the first {SHOWN} of {plan.rows.length} rows.</p>}
        </>)}
      </div>
    </Panel>
  );
}
