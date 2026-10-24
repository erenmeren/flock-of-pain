"use client";

import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { type ApiError, type SimulateResponse, generate, getExample, simulate } from "@/lib/api";

const POLICIES = ["priority", "fifo", "least_loaded"];

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [company, setCompany] = useState("");
  const [scenarios, setScenarios] = useState("");
  const [seed, setSeed] = useState("42");
  const [days, setDays] = useState("10");
  const [reps, setReps] = useState("5");
  const [policy, setPolicy] = useState("priority");
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getExample()
      .then((x) => {
        setCompany(JSON.stringify(x.company, null, 2));
        setScenarios(JSON.stringify(x.scenarios, null, 2));
      })
      .catch(setError);
  }, []);

  async function gen() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const x = await generate(prompt);
      setCompany(JSON.stringify(x.company, null, 2));
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
      };
    } catch (e) {
      setError({ path: null, message: `Invalid JSON: ${(e as Error).message}` });
      return;
    }
    setBusy(true);
    try {
      setResult(await simulate(body));
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
        <Textarea aria-label="company JSON" className="h-64 font-mono" value={company} onChange={(e) => setCompany(e.target.value)} />
        <Textarea aria-label="scenarios JSON" className="h-64 font-mono" value={scenarios} onChange={(e) => setScenarios(e.target.value)} />
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
        <Button onClick={run} disabled={busy}>Run</Button>
      </div>
      <div className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.path ?? "Error"}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}
        {result && (
          <>
            <p className="text-sm">{result.disclaimer}</p>
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
