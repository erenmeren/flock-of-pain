"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { CompanyEditor } from "@/components/company-editor";
import { Playback } from "@/components/playback";
import {
  type ApiError, type CompanyMeta, type RunMeta, type SimulateResponse,
  deleteCompany, generate, getExample, getRun, listCompanies, listRuns, loadCompany, saveCompany, simulate,
} from "@/lib/api";
import { type Company, parseCompany } from "@/lib/company";

const POLICIES = ["priority", "fifo", "least_loaded"];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [company, setCompany] = useState(""); // JSON text: what Run sends
  const [companyObj, setCompanyObj] = useState<Company | null>(null); // parsed twin for the editor; null = text is not valid JSON
  const [scenarios, setScenarios] = useState("");
  const [seed, setSeed] = useState("42");
  const [days, setDays] = useState("10");
  const [reps, setReps] = useState("5");
  const [policy, setPolicy] = useState("priority");
  const [withEvents, setWithEvents] = useState(false);
  const [saveRun, setSaveRun] = useState(false);
  const [saved, setSaved] = useState<CompanyMeta[]>([]);
  const [selected, setSelected] = useState("");
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getExample()
      .then((x) => {
        setBoth(x.company as Company);
        setScenarios(JSON.stringify(x.scenarios, null, 2));
      })
      .catch(setError);
    refreshLists(false);
  }, []);

  function refreshLists(report = true) {
    const onErr = report ? setError : () => {}; // the first load already reports an unreachable API
    listCompanies().then(setSaved).catch(onErr);
    listRuns().then(setRuns).catch(onErr);
  }

  function bundle() {
    return { company: JSON.parse(company), scenarios: JSON.parse(scenarios) as unknown[] };
  }

  async function act(fn: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof SyntaxError ? { path: null, message: `Invalid JSON: ${e.message}` } : (e as ApiError));
    } finally {
      setBusy(false);
    }
  }

  const save = () => act(async () => {
    const b = bundle();
    const id = (b.company as Company).id;
    if (saved.some((c) => c.id === id) && !confirm(`Replace the saved company "${id}"?`)) return;
    await saveCompany(id, b);
    setSelected((b.company as Company).id);
    refreshLists();
  });
  const load = () => act(async () => {
    const b = await loadCompany(selected);
    setBoth(b.company as Company);
    setScenarios(JSON.stringify(b.scenarios, null, 2));
    setResult(null);
  });
  const remove = () => act(async () => {
    if (!confirm(`Delete the saved company "${selected}"? This cannot be undone.`)) return;
    await deleteCompany(selected);
    setSelected("");
    refreshLists();
  });
  const showRun = (id: number) => act(async () => {
    setResult((await getRun(id)).result);
  });

  function setBoth(c: Company) {
    setCompanyObj(c);
    setCompany(JSON.stringify(c, null, 2));
  }

  function syncFromText(text: string) {
    try {
      setCompanyObj(parseCompany(text));
    } catch {
      setCompanyObj(null);
    }
  }

  async function gen() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const x = await generate(prompt);
      setBoth(x.company as Company);
      setScenarios(JSON.stringify(x.scenarios, null, 2));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setError(null);
    setResult(null);
    let body;
    try {
      body = {
        company: JSON.parse(company),
        scenarios: JSON.parse(scenarios),
        config: { seed: Number(seed), days: Number(days), replications: Number(reps), policy },
        include_events: withEvents,
        save: saveRun,
        company_id: saved.some((c) => c.id === companyObj?.id) ? companyObj?.id : null,
      };
    } catch (e) {
      setError({ path: null, message: `Invalid JSON: ${(e as Error).message}` });
      return;
    }
    setBusy(true);
    try {
      setResult(await simulate(body));
      if (saveRun) refreshLists();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const fmt = (s?: { mean: number; p10: number; p90: number }) =>
    s ? `${s.mean.toFixed(2)} (${s.p10.toFixed(2)}–${s.p90.toFixed(2)})` : "";
  const rows = result?.kpi_keys ?? [];

  return (
    <main className="grid gap-6 p-6 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Textarea aria-label="company description" placeholder="Describe the company in words; Claude writes the JSON below" className="h-24" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <Button variant="outline" onClick={gen} disabled={busy || !prompt.trim()}>Generate</Button>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={selected} items={Object.fromEntries(saved.map((c) => [c.id, c.name]))} onValueChange={(v) => setSelected(v ?? "")}>
            <SelectTrigger aria-label="saved company" className="w-48"><SelectValue placeholder="saved companies" /></SelectTrigger>
            <SelectContent>{saved.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={busy || !selected}>Load</Button>
          <Button variant="outline" size="sm" onClick={remove} disabled={busy || !selected}>Delete</Button>
          <Button variant="outline" size="sm" onClick={save} disabled={busy}>Save company</Button>
        </div>
        <Tabs defaultValue="editor">
          <TabsList>
            <TabsTrigger value="editor">Editor</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          <TabsContent value="editor">
            {companyObj ? (
              <CompanyEditor company={companyObj} onChange={setBoth} />
            ) : (
              <p className="text-sm">Company JSON is invalid; fix it in the JSON tab.</p>
            )}
          </TabsContent>
          <TabsContent value="json" className="flex flex-col gap-4">
            <Textarea aria-label="company JSON" className="h-64 font-mono" value={company}
              onChange={(e) => setCompany(e.target.value)} onBlur={(e) => syncFromText(e.target.value)} />
            <Textarea aria-label="scenarios JSON" className="h-64 font-mono" value={scenarios} onChange={(e) => setScenarios(e.target.value)} />
          </TabsContent>
        </Tabs>
        <div className="grid grid-cols-3 gap-2">
          <Input type="number" aria-label="seed" value={seed} onChange={(e) => setSeed(e.target.value)} />
          <Input type="number" aria-label="days" value={days} onChange={(e) => setDays(e.target.value)} />
          <Input type="number" aria-label="reps" value={reps} onChange={(e) => setReps(e.target.value)} />
        </div>
        <Select value={policy} onValueChange={(v) => v && setPolicy(v)}>
          <SelectTrigger aria-label="policy"><SelectValue /></SelectTrigger>
          <SelectContent>
            {POLICIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <Label className="flex items-center gap-2 text-sm">
          <Checkbox aria-label="include events" checked={withEvents} onCheckedChange={(c) => setWithEvents(!!c)} />
          Include events for playback (at most 30 run-days: days x reps x scenarios)
        </Label>
        <Label className="flex items-center gap-2 text-sm">
          <Checkbox aria-label="save run" checked={saveRun} onCheckedChange={(c) => setSaveRun(!!c)} />
          Save the result to run history (without events)
        </Label>
        <Button onClick={run} disabled={busy}>Run</Button>
      </div>
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.path ?? "Error"}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {runs.length > 0 && (
          <Card>
            <CardHeader><CardTitle>Run history</CardTitle></CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow><TableHead>#</TableHead><TableHead>Name</TableHead><TableHead>Company</TableHead><TableHead>When (UTC)</TableHead><TableHead /></TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.id}</TableCell><TableCell>{r.name}</TableCell><TableCell>{r.company_id ?? ""}</TableCell>
                      <TableCell>{r.created_at.replace("T", " ").replace("+00:00", "")}</TableCell>
                      <TableCell><Button variant="ghost" size="sm" aria-label={`show run ${r.id}`} onClick={() => showRun(r.id)} disabled={busy}>Show</Button></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
        {result && (
          <>
            <p className="text-sm">{result.disclaimer}</p>
            <Playback scenarios={result.scenarios} />
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>KPI</TableHead>
                  {result.scenarios.map((s) => <TableHead key={s.id}>{s.name}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((k) => (
                  <TableRow key={k}>
                    <TableCell>{k}</TableCell>
                    {result.scenarios.map((s) => <TableCell key={s.id}>{fmt(s.summary[k])}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {result.scenarios.map((s) => (
              <Card key={s.id}>
                <CardHeader><CardTitle>{s.name}</CardTitle></CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <p className="text-sm">Off-shift minutes: {s.off_shift_minutes.toFixed(2)}</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Department</TableHead>
                        <TableHead>Reason</TableHead>
                        <TableHead>Blocker</TableHead>
                        <TableHead>Minutes</TableHead>
                        <TableHead>Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.ledger.map((r, i) => (
                        <TableRow key={i}>
                          <TableCell>{r.department_id}</TableCell>
                          <TableCell>{r.reason ?? ""}</TableCell>
                          <TableCell>{r.blocker_id ?? ""}</TableCell>
                          <TableCell>{r.minutes.toFixed(2)}</TableCell>
                          <TableCell>{r.count}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
