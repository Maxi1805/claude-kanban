/**
 * Typed API client — a thin `fetch` wrapper over the backend `/api` routes.
 *
 * All paths are relative (`/api/...`) so the Vite dev proxy forwards them to
 * the backend on :8787, and the same build works in production behind any host.
 * Request/response bodies use the shared camelCase contract types verbatim.
 */
import type {
  Project,
  Task,
  AddRepoDTO,
  CreateProjectDTO,
  UpdateProjectDTO,
  CreateTaskDTO,
  UpdateTaskDTO,
  UpdateRepoDTO,
  ApiError,
  FsRootsResponse,
  FsListResponse,
  FsInspectResponse,
  CommandKind,
  RunCommandResult,
  TaskSchemaResponse,
  TaskSchemaRepo,
  TaskCodeResponse,
} from "@shared/types";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

/** Error thrown for any non-2xx API response, carrying the server message. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (cause) {
    throw new ApiRequestError(0, "Network error — is the server running?", cause);
  }

  // 204 / empty body → resolve as undefined for void-returning calls.
  const text = await res.text();
  const body: unknown = text ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    const err = body as ApiError | undefined;
    throw new ApiRequestError(
      res.status,
      err?.error ?? `Request failed (${res.status})`,
      err?.details,
    );
  }
  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Public surface of the API client used by the store. */
export interface ApiClient {
  // Projects
  listProjects(opts?: { withRepos?: boolean }): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(dto: CreateProjectDTO): Promise<Project>;
  updateProject(id: string, patch: UpdateProjectDTO): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  addRepo(projectId: string, dto: AddRepoDTO): Promise<Project>;
  updateRepo(
    projectId: string,
    repoId: string,
    patch: UpdateRepoDTO,
  ): Promise<Project>;
  removeRepo(projectId: string, repoId: string): Promise<void>;
  // Tasks
  listTasks(opts?: { projectId?: string; withRepos?: boolean }): Promise<Task[]>;
  getTask(id: string): Promise<Task>;
  createTask(dto: CreateTaskDTO): Promise<Task>;
  updateTask(id: string, dto: UpdateTaskDTO): Promise<Task>;
  /**
   * Restart a task's agent in place: the backend kills the pty and the terminal's
   * reconnect revives it with `claude --continue`. The only way a plugin setting
   * toggled mid-session takes effect. `restarted` is false when nothing was live.
   */
  restartAgent(id: string): Promise<{ task: Task; restarted: boolean }>;
  deleteTask(id: string): Promise<void>;
  // Per-repo commands: inject a lifecycle script into the repo's shell. `run`
  // exports a fresh $PORT first; the returned `port` is null for setup/teardown.
  runCommand(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<RunCommandResult>;
  // Filesystem browser (local-only)
  fsRoots(): Promise<FsRootsResponse>;
  fsList(
    path?: string,
    opts?: { includeFiles?: boolean },
  ): Promise<FsListResponse>;
  fsInspect(path: string): Promise<FsInspectResponse>;
  // Declared schema of a task's worktrees (for the per-task diagram)
  taskSchema(taskId: string): Promise<TaskSchemaResponse>;
  /** Have an agent write this repo's extractor. Slow: it reads the codebase. */
  generateSchemaScript(taskId: string, repoName: string): Promise<TaskSchemaRepo>;
  deleteSchemaScript(taskId: string, repoName: string): Promise<void>;
  // Code hotspots of a task's worktrees (for the per-task refactoring view).
  // Analysis runs (and re-runs) server-side on request; `analyzing` on each
  // repo tells the caller whether to keep polling.
  // P3: `page` requests a slice of the already-ranked groups. OLA BA: el
  // default del servidor dejó de ser 200 y pasó a ser TODO (BA1,
  // `code-inspector.ts#resolvePage`), así que ausente ⇒ el repo entero. El
  // panel ya no lo manda; el parámetro sigue porque el servidor lo sigue
  // respetando si alguien pide una porción explícitamente. Aplica igual a
  // cada repo de la tarea (ver `code-inspector.ts`).
  taskCode(
    taskId: string,
    page?: { offset?: number; limit?: number | "unlimited" },
  ): Promise<TaskCodeResponse>;
  // F2: discard/restore a finding or opportunity by its stable id. Persists
  // per repository, so it survives a re-analysis and every future task on
  // the same repo, not just this one.
  discardCodeFinding(
    taskId: string,
    repoName: string,
    findingId: string,
    reason: string,
  ): Promise<void>;
  restoreCodeFinding(taskId: string, repoName: string, findingId: string): Promise<void>;
}

class FetchApiClient implements ApiClient {
  /* ── Projects ─────────────────────────────────────────────────────── */

  listProjects(opts?: { withRepos?: boolean }): Promise<Project[]> {
    const qs = opts?.withRepos ? "?withRepos=1" : "";
    return request<Project[]>(`/api/projects${qs}`);
  }

  getProject(id: string): Promise<Project> {
    return request<Project>(`/api/projects/${encodeURIComponent(id)}`);
  }

  createProject(dto: CreateProjectDTO): Promise<Project> {
    return request<Project>("/api/projects", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(dto),
    });
  }

  updateProject(id: string, patch: UpdateProjectDTO): Promise<Project> {
    return request<Project>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(patch),
    });
  }

  deleteProject(id: string): Promise<void> {
    return request<void>(`/api/projects/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  addRepo(projectId: string, dto: AddRepoDTO): Promise<Project> {
    return request<Project>(`/api/projects/${encodeURIComponent(projectId)}/repos`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(dto),
    });
  }

  updateRepo(
    projectId: string,
    repoId: string,
    patch: UpdateRepoDTO,
  ): Promise<Project> {
    return request<Project>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`,
      {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify(patch),
      },
    );
  }

  removeRepo(projectId: string, repoId: string): Promise<void> {
    return request<void>(
      `/api/projects/${encodeURIComponent(projectId)}/repos/${encodeURIComponent(repoId)}`,
      { method: "DELETE" },
    );
  }

  /* ── Tasks ────────────────────────────────────────────────────────── */

  listTasks(opts?: { projectId?: string; withRepos?: boolean }): Promise<Task[]> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set("projectId", opts.projectId);
    if (opts?.withRepos) params.set("withRepos", "1");
    const qs = params.toString();
    return request<Task[]>(`/api/tasks${qs ? `?${qs}` : ""}`);
  }

  getTask(id: string): Promise<Task> {
    return request<Task>(`/api/tasks/${encodeURIComponent(id)}`);
  }

  createTask(dto: CreateTaskDTO): Promise<Task> {
    return request<Task>("/api/tasks", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(dto),
    });
  }

  updateTask(id: string, dto: UpdateTaskDTO): Promise<Task> {
    return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify(dto),
    });
  }

  restartAgent(id: string): Promise<{ task: Task; restarted: boolean }> {
    return request<{ task: Task; restarted: boolean }>(
      `/api/tasks/${encodeURIComponent(id)}/agent/restart`,
      { method: "POST", headers: JSON_HEADERS },
    );
  }

  deleteTask(id: string): Promise<void> {
    return request<void>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /* ── Per-repo commands ────────────────────────────────────────────── */

  runCommand(
    taskId: string,
    repoId: string,
    kind: CommandKind,
  ): Promise<RunCommandResult> {
    return request<RunCommandResult>(
      `/api/tasks/${encodeURIComponent(taskId)}/repos/${encodeURIComponent(
        repoId,
      )}/run/${encodeURIComponent(kind)}`,
      { method: "POST" },
    );
  }

  /* ── Filesystem browser ───────────────────────────────────────────── */

  fsRoots(): Promise<FsRootsResponse> {
    return request<FsRootsResponse>("/api/fs/roots");
  }

  fsList(
    path?: string,
    opts?: { includeFiles?: boolean },
  ): Promise<FsListResponse> {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (opts?.includeFiles) params.set("includeFiles", "1");
    const qs = params.toString();
    return request<FsListResponse>(`/api/fs/list${qs ? `?${qs}` : ""}`);
  }

  fsInspect(path: string): Promise<FsInspectResponse> {
    return request<FsInspectResponse>(
      `/api/fs/inspect?path=${encodeURIComponent(path)}`,
    );
  }

  /* ── Per-task declared schema ─────────────────────────────────────── */

  taskSchema(taskId: string): Promise<TaskSchemaResponse> {
    return request<TaskSchemaResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/schema`,
    );
  }

  generateSchemaScript(taskId: string, repoName: string): Promise<TaskSchemaRepo> {
    return request<TaskSchemaRepo>(
      `/api/tasks/${encodeURIComponent(taskId)}/schema/${encodeURIComponent(
        repoName,
      )}/generate`,
      { method: "POST" },
    );
  }

  deleteSchemaScript(taskId: string, repoName: string): Promise<void> {
    return request<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/schema/${encodeURIComponent(repoName)}`,
      { method: "DELETE" },
    );
  }

  /* ── Per-task code hotspots ───────────────────────────────────────── */

  taskCode(
    taskId: string,
    page?: { offset?: number; limit?: number | "unlimited" },
  ): Promise<TaskCodeResponse> {
    const params = new URLSearchParams();
    if (page?.offset !== undefined) params.set("offset", String(page.offset));
    if (page?.limit !== undefined) params.set("limit", String(page.limit));
    const qs = params.toString();
    return request<TaskCodeResponse>(
      `/api/tasks/${encodeURIComponent(taskId)}/code${qs ? `?${qs}` : ""}`,
    );
  }

  discardCodeFinding(
    taskId: string,
    repoName: string,
    findingId: string,
    reason: string,
  ): Promise<void> {
    return request<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/code/${encodeURIComponent(
        repoName,
      )}/findings/${encodeURIComponent(findingId)}/discard`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ reason }) },
    );
  }

  restoreCodeFinding(taskId: string, repoName: string, findingId: string): Promise<void> {
    return request<void>(
      `/api/tasks/${encodeURIComponent(taskId)}/code/${encodeURIComponent(
        repoName,
      )}/findings/${encodeURIComponent(findingId)}/restore`,
      { method: "POST" },
    );
  }
}

/** Build the ws URL for a task's pty channel. */
export function ptyWsUrl(taskId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/pty?taskId=${encodeURIComponent(taskId)}`;
}

/** Build the ws URL for a repo's command-shell channel. */
export function cmdWsUrl(taskId: string, repoId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const qs = new URLSearchParams({ taskId, repoId }).toString();
  return `${proto}://${location.host}/ws/cmd?${qs}`;
}

/** Build the ws URL for the board events broadcast channel. */
export function eventsWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws/events`;
}

/** Shared singleton client. */
export const api: ApiClient = new FetchApiClient();
