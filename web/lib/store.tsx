"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type ApiError, type Bundle, type CompanyMeta, type Limits, type Me, type RunMeta, type SimulateResponse,
  SESSION_EXPIRED, cancelJob, credential, deleteCompany, generate as apiGenerate, getExample, getLimits, getMe, getRun, listCompanies, listRuns, loadApiKey, loadCompany, loadSession, login, logout, saveCompany, setApiKey, setOnSessionExpired, setSession, startJob, waitForJob,
} from "@/lib/api";
import { type Company, type Scenario, checkCompany, checkScenarios, slug } from "@/lib/company";
import { blockingIssue } from "@/components/process/graph";
import { useConfirm } from "@/lib/confirm";
import { type History, type SaveBase, type SaveSync, conflictOf, emptyHistory, record, redo as redoStep, saveBody, shouldAutosave, undo as undoStep } from "@/lib/history";
import { DEFAULT_LIMITS } from "@/lib/sweep";

export type Config = { seed: number; days: number; warmup_days?: number; replications: number; policy: string; crn: boolean; include_events: boolean; save: boolean };
export const DEFAULT_CONFIG: Config = { seed: 42, days: 10, replications: 5, policy: "priority", crn: true, include_events: false, save: false };
export const POLICIES = ["priority", "fifo", "least_loaded", "edd"];

/** Where the shown result came from, so a page never mixes another company's numbers with this one. A live run keeps the config it was started with. */
export type ResultSource = { kind: "run"; company_id: string; name: string; config: Config } | { kind: "history"; run_id: number; name: string };

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
  authed: boolean; // a session token or API key is stored (not yet proof that it is valid; `me` is)
  me: Me | null;
  viewer: boolean;
  busy: boolean;
  progress: { done: number; total: number } | null; // non-null while a run's job is under way (total 0 until the first poll)
  cancelling: boolean;
  canUndo: boolean;
  canRedo: boolean;
  draftStatus: { state: "unsaved" | "saved" | "saving" | "conflict" } | { state: "failed"; message: string };
  conflict: SaveBase | null; // someone else saved the draft's company since it was loaded or saved here; autosave waits for a choice
  limits: Limits; // the API's job limits, or the defaults when it does not say
  error: ApiError | null;
  setCompany: (c: Company) => void;
  setScenarios: (s: Scenario[]) => void;
  setConfig: (c: Config) => void;
  setError: (e: ApiError | null) => void;
  changeKey: (k: string) => void;
  signIn: (email: string, password: string) => Promise<boolean>; // false = failed, reported through `error`
  signOut: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  cancelRun: () => Promise<void>;
  loadExample: () => Promise<void>;
  create: (name: string) => Promise<boolean>; // empty company named after the input, baseline scenario only; false = kept the draft
  generate: (prompt: string) => Promise<void>;
  run: () => Promise<void>;
  save: () => Promise<void>;
  overwrite: () => Promise<void>; // resolves `conflict` by saving the draft over the other version
  load: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  showRun: (id: number) => Promise<void>;
  refreshLists: () => void;
};

const DRAFT = "flock_draft"; // the working copy survives a reload; saved companies live in the API
const BAD_DRAFT = "flock_draft_bad"; // a draft that failed checkCompany, kept so a reload does not lose it
const AUTOSAVE_MS = 2000;
const ABANDONED = new Error("run abandoned"); // thrown out of waitForJob's progress callback to stop polling
type Draft = { company: Company; scenarios: Scenario[] };
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
  const [token, setToken] = useState("");
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Twin["progress"]>(null);
  const [cancelling, setCancelling] = useState(false);
  const [history, setHistory] = useState<History<Draft>>(emptyHistory);
  const [sync, setSync] = useState<SaveSync>({ rev: 0, saved: 0 });
  const [autoSaving, setAutoSaving] = useState(false);
  const [saveFail, setSaveFail] = useState<{ rev: number; message: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [base, setBaseState] = useState<SaveBase | null>(null);
  const [conflict, setConflict] = useState<SaveBase | null>(null);
  const [limits, setLimits] = useState<Limits>(DEFAULT_LIMITS);
  const baseRef = useRef<SaveBase | null>(null); // read when a queued PUT starts, so it carries the version the previous PUT wrote
  const jobId = useRef<string | null>(null);
  const alive = useRef(true);
  const lastTenant = useRef<string | null>(null); // survives an expired session: signing back in to the same tenant keeps its state
  const saves = useRef<Promise<unknown>>(Promise.resolve()); // PUTs run one at a time, so responses cannot race

  useEffect(() => {
    alive.current = true; // the provider lives in the layout: only its own unmount stops a run's polling
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setOnSessionExpired(() => {
      setToken("");
      setMe(null);
      setError(SESSION_EXPIRED);
    });
    return () => setOnSessionExpired(() => {});
  }, []);

  const setBase = useCallback((b: SaveBase | null) => {
    baseRef.current = b;
    setBaseState(b);
  }, []);

  /** Resolves true when saved, false on an edit conflict (then in `conflict`); other errors reject. */
  const put = useCallback((id: string, bundle: Bundle) => {
    const p = saves.current.then(async () => {
      try {
        const m = await saveCompany(id, saveBody(bundle, baseRef.current, id));
        setBase({ id, updated_at: m.updated_at });
        setConflict(null);
        return true;
      } catch (e) {
        const c = conflictOf(e, id);
        if (!c) throw e;
        setConflict(c);
        return false;
      }
    });
    saves.current = p.catch(() => {});
    return p;
  }, [setBase]);

  /** A different company became the draft: nothing to undo, nothing to autosave. */
  const adopt = useCallback((c: Company, sc: Scenario[], id: string, updatedAt?: string) => {
    setBase(id && updatedAt ? { id, updated_at: updatedAt } : null);
    setConflict(null);
    setCompanyState(c);
    setScenariosState(sc);
    setSelected(id);
    setResult(null);
    setResultSource(null);
    setHistory(emptyHistory());
    setSync((s) => ({ ...s, saved: s.rev }));
  }, [setBase]);

  const refreshLists = useCallback((report = true) => {
    const onErr = report ? setError : () => {};
    listCompanies().then(setSaved).catch(onErr);
    listRuns().then(setRuns).catch(onErr);
  }, []);

  const loadExample = useCallback(async () => {
    const x = await getExample();
    adopt(x.company as Company, x.scenarios as Scenario[], "");
  }, [adopt]);

  const refreshMe = useCallback(() => {
    const used = credential();
    if (!used) return;
    getMe().then((m) => { // a slow answer about the previous credential must not label the new one
      if (credential() !== used) return;
      lastTenant.current = m.tenant;
      setMe(m);
    }).catch(() => {}); // a bad credential or a down API shows as "not verified"
  }, []);

  useEffect(() => {
    // localStorage exists only in the browser; the microtask keeps the first paint identical to the server's
    Promise.resolve().then(() => {
      setKeyState(loadApiKey());
      setToken(loadSession());
      refreshMe();
      let draft: { company: Company; scenarios: Scenario[]; config?: Config; selected?: string; dirty?: boolean; base?: SaveBase | null } | null = null;
      const raw = localStorage.getItem(DRAFT);
      try {
        draft = JSON.parse(raw ?? "null");
        if (draft?.company) draft = { ...draft, company: checkCompany(draft.company), scenarios: checkScenarios(draft.scenarios ?? []) };
      } catch (e) { // corrupt or old-shape draft: start from the example, but keep the user's copy before the persist effect overwrites it
        draft = null;
        try { localStorage.setItem(BAD_DRAFT, raw ?? ""); } catch { /* quota: nothing more to keep */ }
        setError({ path: "draft", message: `The saved draft was invalid (${e instanceof Error ? e.message : String(e)}); it is kept in localStorage under ${BAD_DRAFT}.` });
      }
      if (draft?.company) {
        setCompanyState(draft.company);
        setScenariosState(draft.scenarios ?? []);
        setConfig({ ...DEFAULT_CONFIG, ...draft.config });
        setSelected(draft.selected ?? "");
        setBase(draft.base ?? null);
        if (draft.dirty) setSync({ rev: 0, saved: -1 }); // edited after its last save: shown as unsaved, written on the next edit
      } else {
        loadExample().catch(setError);
      }
      refreshLists(false);
    });
  }, [loadExample, refreshLists, refreshMe, setBase]);

  const dirty = sync.rev !== sync.saved;
  useEffect(() => {
    if (!company) return;
    try { localStorage.setItem(DRAFT, JSON.stringify({ company, scenarios, config, selected, dirty, base })); } catch { /* quota or private window: draft lives in memory only */ }
  }, [company, scenarios, config, selected, dirty, base]);

  // once per credential: a sign-in, a key change or a reload
  useEffect(() => {
    if (!token && !apiKey) return;
    let live = true;
    getLimits().then((l) => { if (live) setLimits(l); }, () => { if (live) setLimits(DEFAULT_LIMITS); }); // an older API has no /limits
    return () => { live = false; };
  }, [token, apiKey]);

  const viewer = me?.role === "viewer";
  const canWrite = !!me && !viewer;
  // every PUT carries the updated_at it is based on; the API answers 409 when someone else saved since, and `conflict` holds autosave until the user picks a version
  const conflicted = !!conflict && conflict.id === company?.id;
  useEffect(() => {
    if (!company || !shouldAutosave({ companyId: company.id, selected, canWrite, sync, failedRev: saveFail?.rev ?? null, saving: autoSaving, conflict: conflicted })) return;
    const { rev } = sync;
    const t = setTimeout(async () => {
      setAutoSaving(true);
      try {
        if (!(await put(company.id, { company, scenarios }))) return;
        setSync((s) => ({ ...s, saved: Math.max(s.saved, rev) }));
        listCompanies().then(setSaved).catch(() => {});
      } catch (e) {
        setSaveFail({ rev, message: (e as ApiError).message ?? String(e) });
      } finally {
        setAutoSaving(false);
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [company, scenarios, selected, canWrite, sync, saveFail?.rev, autoSaving, conflicted, put]);

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

  const clearTenant = useCallback(() => {
    setSaved([]); // the previous tenant's lists must not linger
    setRuns([]);
    setSelected("");
    setResult(null);
    setResultSource(null);
    setConflict(null);
  }, []);

  /** Before credentials change: the run belongs to the old identity, its result must not land under the new one. */
  const abandonRun = useCallback(() => {
    if (jobId.current) cancelJob(jobId.current).catch(() => {});
    jobId.current = null;
  }, []);

  const value = useMemo<Twin>(() => {
    const remember = () => {
      const now = Date.now();
      if (company) setHistory((h) => record(h, { company, scenarios }, now));
      setSync((s) => ({ ...s, rev: s.rev + 1 }));
    };
    const restore = (step: { history: History<Draft>; state: Draft } | null) => {
      if (!step) return;
      setHistory(step.history);
      setCompanyState(step.state.company);
      setScenariosState(step.state.scenarios);
      setSync((s) => ({ ...s, rev: s.rev + 1 }));
    };
    const onSaved = company && selected === company.id;
    const write = async () => {
      if (!company) return;
      const { rev } = sync;
      if (!(await put(company.id, { company, scenarios }))) return;
      setSelected(company.id);
      setSync((s) => ({ ...s, saved: Math.max(s.saved, rev) }));
      refreshLists();
    };
    return {
    company, scenarios, config, result, resultSource, saved, runs, selected, apiKey, me, viewer, busy, progress, cancelling, error, limits,
    conflict: conflicted ? conflict : null,
    authed: !!apiKey || !!token,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    draftStatus: !onSaved ? { state: "unsaved" } : autoSaving ? { state: "saving" } : conflicted ? { state: "conflict" } : !dirty ? { state: "saved" }
      : saveFail?.rev === sync.rev ? { state: "failed", message: saveFail.message } : { state: "unsaved" },
    setCompany: (c) => {
      if (JSON.stringify(c) === JSON.stringify(company)) return; // e.g. a drag that ends where it began: no empty undo step
      remember();
      setCompanyState(c);
    },
    setScenarios: (sc) => {
      if (JSON.stringify(sc) === JSON.stringify(scenarios)) return;
      remember();
      setScenariosState(sc);
    },
    setConfig, setError,
    undo: () => { if (company) restore(undoStep(history, { company, scenarios })); },
    redo: () => { if (company) restore(redoStep(history, { company, scenarios })); },
    changeKey: (k) => {
      abandonRun();
      if (token) logout().catch(() => {}); // one credential at a time; the header is built before the token is cleared below
      setSession("");
      setToken("");
      setMe(null);
      lastTenant.current = null;
      setApiKey(k);
      setKeyState(k);
      clearTenant();
      if (k) { refreshLists(); refreshMe(); }
    },
    signIn: async (email, password) => {
      try {
        const s = await login(email, password);
        abandonRun();
        setApiKey(""); // one credential at a time: signing out must not fall back to a key with more rights
        setKeyState("");
        setSession(s.token);
        setToken(s.token);
        if (lastTenant.current !== s.tenant) clearTenant();
        lastTenant.current = s.tenant;
        setMe({ tenant: s.tenant, email: s.email, role: s.role });
        setError(null);
        refreshLists();
        return true;
      } catch (e) {
        setError(e as ApiError);
        return false;
      }
    },
    signOut: async () => {
      abandonRun();
      if (token) await logout().catch(() => {}); // already gone when the user changed their own account
      setSession("");
      setToken("");
      setApiKey("");
      setKeyState("");
      setMe(null);
      lastTenant.current = null;
      clearTenant();
    },
    cancelRun: async () => {
      if (!jobId.current) return;
      setCancelling(true); // running replications finish first; the poll in `run` ends it
      try { await cancelJob(jobId.current); } catch (e) { setCancelling(false); setError(e as ApiError); }
    },
    loadExample: async () => { if (await keepDraft(company)) return; await act(loadExample); },
    create: async (name) => {
      if (await keepDraft(company)) return false;
      adopt({ id: slug(name) || "company", name: name.trim(), systems: [], departments: [], workflows: [] }, [{ id: "baseline", name: "Baseline", overlays: [] }], "");
      setError(null);
      return true;
    },
    generate: async (prompt) => { if (await keepDraft(company)) return; await act(async () => {
      const x = await apiGenerate(prompt);
      adopt(x.company as Company, x.scenarios as Scenario[], "");
    }); },
    run: () => act(async () => {
      if (!company) return;
      const issue = blockingIssue(company);
      if (issue) { setError({ path: "company", message: issue.message, href: `/processes/${encodeURIComponent(issue.workflowId)}` }); return; }
      const sent = config; // the report labels the result with this, not with whatever the draft says later
      const { include_events, save, warmup_days, ...cfg } = config;
      const { id } = await startJob({
        company, scenarios, config: warmup_days ? { ...cfg, warmup_days } : cfg, include_events, save: save && !viewer,
        company_id: saved.some((c) => c.id === company.id) ? company.id : null,
      });
      jobId.current = id;
      setProgress({ done: 0, total: 0 });
      try {
        const res = await waitForJob<SimulateResponse>(id, (j) => {
          if (!alive.current || jobId.current !== id) throw ABANDONED;
          setProgress({ done: j.done, total: j.total });
        });
        if (!res) return; // cancelled: the previous result stays
        setResult(res);
        setResultSource({ kind: "run", company_id: company.id, name: company.name, config: sent });
        if (save && !viewer) refreshLists();
      } catch (e) {
        if (e === ABANDONED || jobId.current !== id) return;
        if ((e as ApiError).status === 404) throw { path: "run", message: "This run is gone from the server, most likely because the API restarted. Run it again." } as ApiError;
        throw e;
      } finally {
        jobId.current = null;
        setProgress(null);
        setCancelling(false);
      }
    }),
    save: () => act(async () => {
      if (!company) return;
      if (saved.some((c) => c.id === company.id) && company.id !== selected
        && !(await confirm(`A saved company with the id "${company.id}" already exists.`, { title: "Replace the saved company?", action: "Replace" }))) return;
      await write();
    }),
    overwrite: () => act(async () => {
      if (!company || !conflicted || !conflict) return;
      setBase(conflict); // based on their version now, so the PUT replaces it unless a third save came in between
      await write();
    }),
    load: async (id) => { if (await keepDraft(company)) return; await act(async () => {
      await saves.current; // a PUT still in flight would otherwise record its version as the base of the loaded company
      const b = await loadCompany(id);
      adopt(b.company as Company, b.scenarios as Scenario[], id, b.updated_at);
    }); },
    remove: (id) => act(async () => {
      if (!(await confirm(`"${id}" is removed from this tenant. This cannot be undone.`, { title: "Delete the saved company?", action: "Delete", destructive: true }))) return;
      if (selected === id) setSelected(""); // first, so a debounced autosave cannot bring it back
      await saves.current;
      try { await deleteCompany(id); } catch (e) { if (selected === id) setSelected(id); throw e; }
      refreshLists();
    }),
    showRun: (id) => act(async () => {
      const r = await getRun(id);
      setResult(r.result);
      setResultSource({ kind: "history", run_id: id, name: runs.find((x) => x.id === id)?.name ?? `run ${id}` });
    }),
    refreshLists: () => refreshLists(),
    };
  }, [company, scenarios, config, result, resultSource, saved, runs, selected, apiKey, token, me, viewer, busy, progress, cancelling, history, sync, dirty, autoSaving, saveFail, conflict, conflicted, limits, error, act, adopt, abandonRun, clearTenant, confirm, keepDraft, loadExample, put, refreshLists, refreshMe, setBase]);

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
