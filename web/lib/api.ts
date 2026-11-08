import type { Dist, Profile } from "@/lib/company";
export type Stat = { mean: number; p10: number; p50: number; p90: number; ci_low?: number; ci_high?: number }; // no interval in runs saved before they existed
export type Comparison = { delta: number; ci_low: number; ci_high: number; significant: boolean };
export type Recommendation = { severity: "high" | "medium" | "info"; kind: string; department_id: string | null; message: string };
export type LedgerRow = {
  department_id: string;
  reason: string | null;
  blocker_id: string | null;
  minutes: number;
  count: number;
};
export type SimEvent = {
  t: number;
  kind: string;
  task_id: string | null;
  instance_id: string | null;
  workflow_id: string | null;
  step_id: string | null;
  department_id: string | null;
  resource_id: string | null;
  system_id: string | null;
  reason: string | null;
  payload: Record<string, unknown>;
};
/** Per engine workflow (one per inflow when a workflow has 2+), as analytics.WorkflowMetrics. */
export type WorkflowMetrics = {
  started: number; completed: number; cancelled: number; throughput_per_day: number;
  cycle_p50: number; cycle_p90: number; wait_p50: number; wait_p90: number;
  sla_breached: number; sla_breach_rate: number; deadline_missed: number; deadline_miss_rate: number; abandoned?: number; abandon_rate?: number; // absent in runs saved before abandonment steps_completed: number; failures: number;
  rework_rate: number; cost_per_completed: number;
};
export type RunResult = { seed: number; metrics: { workflows: Record<string, WorkflowMetrics>; [k: string]: unknown }; events?: SimEvent[] };
export type ScenarioResult = {
  id: string;
  name: string;
  summary: Record<string, Stat>;
  ledger: LedgerRow[];
  off_shift_minutes: number;
  runs: RunResult[];
  comparison?: Record<string, Comparison>; // every scenario after the first, against the first
  recommendations?: Recommendation[];
};
export type SimulateResponse = {
  disclaimer: string;
  kpi_keys: string[];
  scenarios: ScenarioResult[];
  run_id?: number; // present when the request asked to save
};
export type Bundle = { company: unknown; scenarios: unknown[] };
export type CompanyMeta = { id: string; name: string; updated_at: string };
export type RunMeta = { id: number; company_id: string | null; name: string; created_at: string };
export type ApiError = { path: string | null; message: string; href?: string; status?: number };
export type Role = "admin" | "editor" | "viewer";
export type Me = { tenant: string; email: string | null; role: Role }; // email null for an API key
export type UserRow = { email: string; role: Role; created_at: string };

export const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// Tenant API key (`flock_of_pain tenant create`), sent as X-API-Key on every call except /example.
const KEY_STORAGE = "flock_api_key";
let apiKey = "";
export function loadApiKey(): string {
  try { apiKey = localStorage.getItem(KEY_STORAGE) ?? ""; } catch { apiKey = ""; }
  return apiKey;
}
export function setApiKey(key: string) {
  apiKey = key;
  try { if (key) localStorage.setItem(KEY_STORAGE, key); else localStorage.removeItem(KEY_STORAGE); } catch { /* private window: key lives for this page only */ }
}

// shortcut: the session token sits in localStorage with the key's XSS exposure (see README), move to an HttpOnly cookie if the API and web app share a site.
const SESSION_STORAGE = "flock_session";
let sessionToken = "";
export function loadSession(): string {
  try { sessionToken = localStorage.getItem(SESSION_STORAGE) ?? ""; } catch { sessionToken = ""; }
  return sessionToken;
}
export function setSession(token: string) {
  sessionToken = token;
  try { if (token) localStorage.setItem(SESSION_STORAGE, token); else localStorage.removeItem(SESSION_STORAGE); } catch { /* private window: token lives for this page only */ }
}
/** What requests authenticate with right now; only one is ever sent. */
export const credential = () => sessionToken || apiKey;
export const SESSION_EXPIRED: ApiError = { path: "session", message: "Session expired, sign in again", href: "/settings" };
let onSessionExpired = () => {};
export const setOnSessionExpired = (fn: () => void) => { onSessionExpired = fn; };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const open = path === "/signup" || path === "/auth/login"; // their 401 is about the submitted credentials, not the session
  const token = open ? "" : sessionToken;
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (apiKey && !open) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.ok) return res.json();
  const j = await res.json().catch(() => null);
  if (res.status === 401 && !open) {
    if (token) {
      if (sessionToken === token && path !== "/auth/logout") { setSession(""); onSessionExpired(); } // a newer sign-in keeps its token
      throw SESSION_EXPIRED;
    }
    throw { path: "sign in", message: `${j?.message ?? "unauthorized"}: sign in on the Settings page`, href: "/settings", status: 401 } as ApiError;
  }
  // FastAPI validation errors carry `detail` instead of {path, message}
  if (j && typeof j.message === "string") throw { ...j, status: res.status } as ApiError;
  throw {
    path: null,
    message: j?.detail ? JSON.stringify(j.detail) : `${method} ${path} failed: ${res.status}`,
    status: res.status,
  } as ApiError;
}

export const getExample = () => request<Bundle>("GET", "/example");
export const simulate = (body: unknown) => request<SimulateResponse>("POST", "/simulate", body);
export const generate = (prompt: string) => request<Bundle>("POST", "/generate", { prompt });
/** Creates a tenant when the API has FLOCK_SIGNUP_CODE set; the key comes back once. With email and password it also creates that admin user. */
export const signup = (id: string, invite: string, email?: string, password?: string) =>
  request<{ id: string; key: string }>("POST", "/signup", email ? { id, invite, email, password } : { id, invite });

const enc = encodeURIComponent;
export const login = (email: string, password: string) => request<Me & { token: string; email: string; expires_at: string }>("POST", "/auth/login", { email, password });
export const logout = () => request<{ ok: true }>("POST", "/auth/logout");
export const getMe = () => request<Me>("GET", "/auth/me");
export const listUsers = () => request<UserRow[]>("GET", "/users");
export const createUser = (email: string, password: string, role: Role) => request<UserRow>("POST", "/users", { email, password, role });
export const updateUser = (email: string, patch: { role?: Role; password?: string }) => request<UserRow>("PATCH", `/users/${enc(email)}`, patch);
export const deleteUser = (email: string) => request<{ deleted: string }>("DELETE", `/users/${enc(email)}`);
export const listCompanies = () => request<CompanyMeta[]>("GET", "/companies");
export const saveCompany = (id: string, bundle: Bundle) => request<CompanyMeta>("PUT", `/companies/${enc(id)}`, bundle);
export const loadCompany = (id: string) => request<Bundle>("GET", `/companies/${enc(id)}`);
export const deleteCompany = (id: string) => request<{ deleted: string }>("DELETE", `/companies/${enc(id)}`);
export const listRuns = (companyId?: string | null) =>
  request<RunMeta[]>("GET", `/runs?limit=20${companyId ? `&company_id=${enc(companyId)}` : ""}`);
export const getRun = (id: number) => request<{ request: Bundle & { config: unknown }; result: SimulateResponse }>("GET", `/runs/${id}`);

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Job<R> = { id: string; kind: "simulate" | "optimize"; status: JobStatus; done: number; total: number; result?: R; error?: ApiError };
export type OptimizeTarget = { kpi: string; op: "<=" | ">="; value: number };
export type OptimizeRequest = { company: unknown; scenarios: unknown[]; config: unknown; target: OptimizeTarget; base_scenario_id?: string; candidates?: string[]; max_hires?: number };
export type OptimizeStep = { hires: Record<string, number>; mean: number; ci_low: number; ci_high: number; labor_cost: number };
export type OptimizeResult = { met: boolean; stopped: "met" | "max_hires" | "no_improvement" | "budget"; hires: Record<string, number>; scenario: unknown; path: OptimizeStep[] };
export const startJob = (body: unknown) => request<{ id: string }>("POST", "/jobs", body);
export const startOptimize = (body: OptimizeRequest) => request<{ id: string }>("POST", "/optimize", body);
export const getJob = <R,>(id: string) => request<Job<R>>("GET", `/jobs/${enc(id)}`);
export const cancelJob = (id: string) => request<Job<unknown>>("DELETE", `/jobs/${enc(id)}`);
/** Polls until the job ends. Returns its result, or null when cancelled; a failed job throws its ApiError. */
export async function waitForJob<R>(id: string, onProgress?: (job: Job<R>) => void): Promise<R | null> {
  for (let dropped = 0; ;) {
    let job: Job<R>;
    try {
      job = await getJob<R>(id);
      dropped = 0;
    } catch (e) { // fetch rejects with a TypeError on a network drop; the job keeps running on the server, so ride out a short one
      if (!(e instanceof TypeError) || ++dropped > 30) throw e;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    onProgress?.(job);
    if (job.status === "done") return job.result as R;
    if (job.status === "cancelled") return null;
    if (job.status === "failed") throw job.error ?? ({ path: null, message: "the job failed" } as ApiError);
    await new Promise((r) => setTimeout(r, 400));
  }
}

export type ArrivalFit = { rate_per_hour: number; profile: Profile; observed_days: number };
export type DurationFit = Dist & { n: number; p50: number; p90: number };
export const fitArrivals = (timestamps: string[]) => request<ArrivalFit>("POST", "/calibrate/arrivals", { timestamps });
export const fitDurations = (minutes: number[]) => request<DurationFit>("POST", "/calibrate/durations", { minutes });
