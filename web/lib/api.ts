export type Stat = { mean: number; p10: number; p50: number; p90: number };
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
  sla_breached: number; sla_breach_rate: number; steps_completed: number; failures: number;
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
export type ApiError = { path: string | null; message: string; href?: string };

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.ok) return res.json();
  const j = await res.json().catch(() => null);
  // FastAPI validation errors carry `detail` instead of {path, message}
  if (res.status === 401 && path !== "/signup") throw { path: "api key", message: `${j?.message ?? "unauthorized"}: paste a tenant key (flock_of_pain tenant create)` } as ApiError;
  if (j && typeof j.message === "string") throw j as ApiError;
  throw {
    path: null,
    message: j?.detail ? JSON.stringify(j.detail) : `${method} ${path} failed: ${res.status}`,
  } as ApiError;
}

export const getExample = () => request<Bundle>("GET", "/example");
export const simulate = (body: unknown) => request<SimulateResponse>("POST", "/simulate", body);
export const generate = (prompt: string) => request<Bundle>("POST", "/generate", { prompt });
/** Creates a tenant when the API has FLOCK_SIGNUP_CODE set; the key comes back once. */
export const signup = (id: string, invite: string) => request<{ id: string; key: string }>("POST", "/signup", { id, invite });

const enc = encodeURIComponent;
export const listCompanies = () => request<CompanyMeta[]>("GET", "/companies");
export const saveCompany = (id: string, bundle: Bundle) => request<CompanyMeta>("PUT", `/companies/${enc(id)}`, bundle);
export const loadCompany = (id: string) => request<Bundle>("GET", `/companies/${enc(id)}`);
export const deleteCompany = (id: string) => request<{ deleted: string }>("DELETE", `/companies/${enc(id)}`);
export const listRuns = (companyId?: string | null) =>
  request<RunMeta[]>("GET", `/runs?limit=20${companyId ? `&company_id=${enc(companyId)}` : ""}`);
export const getRun = (id: number) => request<{ request: Bundle & { config: unknown }; result: SimulateResponse }>("GET", `/runs/${id}`);
