"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  type ApiError, type CompanyMeta, type RunMeta, type SimulateResponse,
  deleteCompany, generate as apiGenerate, getExample, getRun, listCompanies, listRuns, loadApiKey, loadCompany, saveCompany, setApiKey, simulate,
} from "@/lib/api";
import { type Company, type Scenario, checkCompany, checkScenarios, slug } from "@/lib/company";
import { blockingIssue } from "@/components/process/graph";
import { useConfirm } from "@/lib/confirm";

export type Config = { seed: number; days: number; replications: number; policy: string; include_events: boolean; save: boolean };
export const DEFAULT_CONFIG: Config = { seed: 42, days: 10, replications: 5, policy: "priority", include_events: false, save: false };
export const POLICIES = ["priority", "fifo", "least_loaded"];

/** Where the shown result came from, so a page never mixes another company's numbers with this one. */
export type ResultSource = { kind: "run"; company_id: string; name: string } | { kind: "history"; run_id: number; name: string };

export type Twin = {
  company: Company | null; // null until the example or a draft is loaded
  scenarios: Scenario[];
  config: Config;
  result: SimulateResponse | null;
  resultSource: ResultSource | null;
  saved: CompanyMeta[];
  runs: RunMeta[];
  selected: string; // id of the saved company the draft came from ("" = unsaved)
  apiKey: string;
  busy: boolean;
  error: ApiError | null;
  setCompany: (c: Company) => void;
  setScenarios: (s: Scenario[]) => void;
  setConfig: (c: Config) => void;
  setError: (e: ApiError | null) => void;
  changeKey: (k: string) => void;
  loadExample: () => Promise<void>;
  create: (name: string) => Promise<boolean>; // empty company named after the input, baseline scenario only; false = kept the draft
  generate: (prompt: string) => Promise<void>;
  run: () => Promise<void>;
  save: () => Promise<void>;
  load: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  showRun: (id: number) => Promise<void>;
  refreshLists: () => void;
};

const DRAFT = "flock_draft"; // the working copy survives a reload; saved companies live in the API
const Ctx = createContext<Twin | null>(null);

export function TwinProvider({ children }: { children: React.ReactNode }) {
  const confirm = useConfirm();
  const [company, setCompanyState] = useState<Company | null>(null);
  const [scenarios, setScenariosState] = useState<Scenario[]>([]);
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [result, setResult] = useState<SimulateResponse | null>(null);
  const [resultSource, setResultSource] = useState<ResultSource | null>(null);
  const [saved, setSaved] = useState<CompanyMeta[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);
  const [selected, setSelected] = useState("");
  const [apiKey, setKeyState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const refreshLists = useCallback((report = true) => {
    const onErr = report ? setError : () => {};
    listCompanies().then(setSaved).catch(onErr);
    listRuns().then(setRuns).catch(onErr);
  }, []);

  const loadExample = useCallback(async () => {
    const x = await getExample();
    setCompanyState(x.company as Company);
    setScenariosState(x.scenarios as Scenario[]);
    setSelected("");
    setResult(null);
    setResultSource(null);
  }, []);

  useEffect(() => {
    // localStorage exists only in the browser; the microtask keeps the first paint identical to the server's
    Promise.resolve().then(() => {
      setKeyState(loadApiKey());
      let draft: { company: Company; scenarios: Scenario[]; config?: Config; selected?: string } | null = null;
      try {
        draft = JSON.parse(localStorage.getItem(DRAFT) ?? "null");
        if (draft?.company) draft = { ...draft, company: checkCompany(draft.company), scenarios: checkScenarios(draft.scenarios ?? []) };
      } catch { draft = null; /* corrupt draft: start from the example */ }
      if (draft?.company) {
        setCompanyState(draft.company);
        setScenariosState(draft.scenarios ?? []);
        setConfig({ ...DEFAULT_CONFIG, ...draft.config });
        setSelected(draft.selected ?? "");
      } else {
        loadExample().catch(setError);
      }
      refreshLists(false);
    });
  }, [loadExample, refreshLists]);

  useEffect(() => {
    if (!company) return;
    try { localStorage.setItem(DRAFT, JSON.stringify({ company, scenarios, config, selected })); } catch { /* quota or private window: draft lives in memory only */ }
  }, [company, scenarios, config, selected]);

  const keepDraft = useCallback(async (c: Company | null) =>
    !!c && !(await confirm("Unsaved changes are lost.", { title: "Replace the current draft?", action: "Replace" })), [confirm]);

  const act = useCallback(async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? { path: null, message: e.message } : (e as ApiError));
    } finally {
      setBusy(false);
    }
  }, []);

  const value = useMemo<Twin>(() => ({
    company, scenarios, config, result, resultSource, saved, runs, selected, apiKey, busy, error,
    setCompany: setCompanyState,
    setScenarios: setScenariosState,
    setConfig, setError,
    changeKey: (k) => {
      setApiKey(k);
      setKeyState(k);
      setSaved([]); // the previous tenant's lists must not linger
      setRuns([]);
      setSelected("");
      setResult(null);
      setResultSource(null);
      if (k) refreshLists();
    },
    loadExample: async () => { if (await keepDraft(company)) return; await act(loadExample); },
    create: async (name) => {
      if (await keepDraft(company)) return false;
      setCompanyState({ id: slug(name) || "company", name: name.trim(), systems: [], departments: [], workflows: [] });
      setScenariosState([{ id: "baseline", name: "Baseline", overlays: [] }]);
      setSelected("");
      setResult(null);
      setResultSource(null);
      setError(null);
      return true;
    },
    generate: async (prompt) => { if (await keepDraft(company)) return; await act(async () => {
      const x = await apiGenerate(prompt);
      setCompanyState(x.company as Company);
      setScenariosState(x.scenarios as Scenario[]);
      setSelected("");
      setResult(null);
      setResultSource(null);
    }); },
    run: () => act(async () => {
      if (!company) return;
      const issue = blockingIssue(company);
      if (issue) { setError({ path: "company", message: issue.message, href: `/processes/${encodeURIComponent(issue.workflowId)}` }); return; }
      const { include_events, save, ...cfg } = config;
      const res = await simulate({
        company, scenarios, config: cfg, include_events, save,
        company_id: saved.some((c) => c.id === company.id) ? company.id : null,
      });
      setResult(res);
      setResultSource({ kind: "run", company_id: company.id, name: company.name });
      if (save) refreshLists();
    }),
    save: () => act(async () => {
      if (!company) return;
      if (saved.some((c) => c.id === company.id) && company.id !== selected
        && !(await confirm(`A saved company with the id "${company.id}" already exists.`, { title: "Replace the saved company?", action: "Replace" }))) return;
      await saveCompany(company.id, { company, scenarios });
      setSelected(company.id);
      refreshLists();
    }),
    load: async (id) => { if (await keepDraft(company)) return; await act(async () => {
      const b = await loadCompany(id);
      setCompanyState(b.company as Company);
      setScenariosState(b.scenarios as Scenario[]);
      setSelected(id);
      setResult(null);
      setResultSource(null);
    }); },
    remove: (id) => act(async () => {
      if (!(await confirm(`"${id}" is removed from this tenant. This cannot be undone.`, { title: "Delete the saved company?", action: "Delete", destructive: true }))) return;
      await deleteCompany(id);
      if (selected === id) setSelected("");
      refreshLists();
    }),
    showRun: (id) => act(async () => {
      const r = await getRun(id);
      setResult(r.result);
      setResultSource({ kind: "history", run_id: id, name: runs.find((x) => x.id === id)?.name ?? `run ${id}` });
    }),
    refreshLists: () => refreshLists(),
  }), [company, scenarios, config, result, resultSource, saved, runs, selected, apiKey, busy, error, act, confirm, keepDraft, loadExample, refreshLists]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTwin(): Twin {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTwin outside TwinProvider");
  return v;
}

const noop = () => () => {};
/** false during server render and hydration, true after: draft-dependent text must wait for it or React reports a hydration mismatch. */
export function useMounted(): boolean {
  return useSyncExternalStore(noop, () => true, () => false);
}
