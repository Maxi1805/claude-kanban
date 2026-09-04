/**
 * Pinia board store — single source of UI state for projects and tasks.
 *
 * State is loaded from the REST API and then kept live by subscribing to the
 * `/ws/events` broadcast channel: every board mutation on the server arrives as
 * a `BoardEventMsg` and is reconciled into local state, so multiple windows (or
 * server-side lifecycle changes) stay in sync without polling.
 */
import { defineStore } from "pinia";
import { api as apiClient, eventsWsUrl } from "@/api/client";
import type {
  CavemanLevel,
  Project,
  Task,
  TaskStatus,
  AddRepoDTO,
  CreateProjectDTO,
  CreateTaskDTO,
  BoardEventMsg,
} from "@/types";
import type { UpdateProjectDTO, UpdateRepoDTO } from "@shared/types";

/* ────────────────────────────────────────────────────────────────────────
 * Per-project create/update DTOs, extended with the two newer per-project
 * fields the modals edit:
 *   • mcpConfigPath — absolute path to a `.mcp.json` FILE, symlinked into each
 *                     task worktree so Claude Code picks up the project MCP
 *                     servers (mirrors claudeMdPath → CLAUDE.md).
 *   • copyFiles     — relative paths copied (not symlinked) from each original
 *                     repo into its worktree (e.g. gitignored `.env` files).
 *
 * These local extensions keep the store strictly typed and forward the fields
 * verbatim to the API; the shared contract carries the same optional fields,
 * so the wire shape is identical.
 * ──────────────────────────────────────────────────────────────────────── */
type ProjectExtraFields = {
  mcpConfigPath?: string | null;
  copyFiles?: string[];
};
export type CreateProjectInput = CreateProjectDTO & ProjectExtraFields;
export type UpdateProjectInput = UpdateProjectDTO & ProjectExtraFields;

/**
 * The shared API client (`@/api/client`) is owned by the backend slice, which
 * adds `updateRepo(projectId, repoId, patch)` per the Phase 1 contract. We
 * reference it through a structurally-augmented view so this store type-checks
 * standalone (and stays correct once the method lands on the concrete client).
 */
type ApiWithUpdateRepo = typeof apiClient & {
  updateRepo(
    projectId: string,
    repoId: string,
    patch: UpdateRepoDTO,
  ): Promise<Project>;
};
const api = apiClient as ApiWithUpdateRepo;

const EMPTY_GROUPS = (): Record<TaskStatus, Task[]> => ({
  todo: [],
  running: [],
  review: [],
  done: [],
});

export interface BoardState {
  projects: Project[];
  tasks: Task[];
  loading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  /** Live websocket connection to /ws/events; null when disconnected. */
  socket: WebSocket | null;
}

export const useBoardStore = defineStore("board", {
  state: (): BoardState => ({
    projects: [],
    tasks: [],
    loading: false,
    error: null,
    selectedProjectId: null,
    socket: null,
  }),

  getters: {
    /** Tasks for the active project (or all when no project is selected). */
    visibleTasks(state): Task[] {
      if (!state.selectedProjectId) return state.tasks;
      return state.tasks.filter((t) => t.projectId === state.selectedProjectId);
    },

    /** Visible tasks bucketed by their kanban status, in stable order. */
    tasksByStatus(): Record<TaskStatus, Task[]> {
      const groups = EMPTY_GROUPS();
      for (const t of this.visibleTasks) groups[t.status].push(t);
      return groups;
    },

    /** The currently selected project object, if any. */
    selectedProject(state): Project | null {
      return state.projects.find((p) => p.id === state.selectedProjectId) ?? null;
    },
  },

  actions: {
    /* ── Loading ──────────────────────────────────────────────────── */

    /** Initial board load: projects (with repos) + tasks, then live updates. */
    async load(): Promise<void> {
      this.loading = true;
      this.error = null;
      try {
        const [projects, tasks] = await Promise.all([
          api.listProjects({ withRepos: true }),
          api.listTasks(),
        ]);
        this.projects = projects;
        this.tasks = tasks;
        if (!this.selectedProjectId && projects.length > 0) {
          this.selectedProjectId = projects[0].id;
        }
        this.connectEvents();
      } catch (err) {
        this.error = errorMessage(err);
      } finally {
        this.loading = false;
      }
    },

    async loadProjects(): Promise<void> {
      this.projects = await api.listProjects({ withRepos: true });
    },

    setSelectedProject(projectId: string | null): void {
      this.selectedProjectId = projectId;
    },

    /* ── Projects ─────────────────────────────────────────────────── */

    async createProject(dto: CreateProjectInput): Promise<Project> {
      const project = await api.createProject(dto);
      this.upsertProject(project);
      this.selectedProjectId = project.id;
      return project;
    },

    /**
     * Patch a project's editable fields (name and/or its per-project Claude
     * config: a CLAUDE.md file path, a `.claude` dir path, the legacy combined
     * folder, the `.mcp.json` MCP config file, and/or the copy-files list). The
     * whole patch is forwarded to the API verbatim and the returned project
     * reconciled into local state.
     */
    async updateProject(
      projectId: string,
      patch: UpdateProjectInput,
    ): Promise<Project> {
      const project = await api.updateProject(projectId, patch as UpdateProjectDTO);
      this.upsertProject(project);
      return project;
    },

    /**
     * Delete a project and everything it owns. The backend tears down every
     * task (worktrees, ptys, branches, ports, transcripts, …) before removing
     * the project, so nothing is orphaned on disk — this can take a moment.
     * Local state is reconciled here (drop the project + its tasks, reselect);
     * the server's `project:deleted` board event is idempotent with this.
     */
    async deleteProject(projectId: string): Promise<void> {
      await api.deleteProject(projectId);
      this.removeProjectFromState(projectId);
    },

    async addRepo(projectId: string, dto: AddRepoDTO): Promise<Project> {
      const project = await api.addRepo(projectId, dto);
      this.upsertProject(project);
      return project;
    },

    /**
     * Remove a repo from a project (DELETE /api/projects/:id/repos/:repoId).
     * The endpoint returns no body, so we reconcile local state by dropping the
     * repo from the project's hydrated `repos` array.
     */
    async removeRepo(projectId: string, repoId: string): Promise<void> {
      await api.removeRepo(projectId, repoId);
      const project = this.projects.find((p) => p.id === projectId);
      if (project?.repos) {
        project.repos = project.repos.filter((r) => r.id !== repoId);
      }
    },

    /**
     * Update an existing repo's lifecycle scripts (setup/run/teardown) via
     * PATCH /api/projects/:projectId/repos/:repoId. The endpoint returns the
     * updated, hydrated Project (consistent with addRepo/removeRepo), which we
     * reconcile wholesale so the project's `repos` array reflects the change.
     */
    async updateRepo(
      projectId: string,
      repoId: string,
      patch: UpdateRepoDTO,
    ): Promise<Project> {
      const project = await api.updateRepo(projectId, repoId, patch);
      this.upsertProject(project);
      return project;
    },

    /* ── Tasks ────────────────────────────────────────────────────── */

    async createTask(dto: CreateTaskDTO): Promise<Task> {
      const task = await api.createTask(dto);
      this.upsertTask(task);
      return task;
    },

    /**
     * Move a task to a new column. Optimistic: the local status flips
     * immediately (so the drag feels instant) and rolls back on failure.
     */
    async moveTask(taskId: string, status: TaskStatus): Promise<void> {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task || task.status === status) return;
      const previous = task.status;
      task.status = status;
      try {
        const updated = await api.updateTask(taskId, { status });
        this.upsertTask(updated);
      } catch (err) {
        task.status = previous; // rollback
        this.error = errorMessage(err);
        throw err;
      }
    },

    /**
     * Toggle the caveman plugin for a task, or switch its compression level.
     * Optimistic like {@link moveTask}: the checkbox/selector reacts instantly
     * and rolls back if the server rejects it. The BACKEND is what reaches the
     * running session — it types the plugin's command into that task's pty — so
     * there is nothing to await here beyond the persisted row.
     */
    async setCaveman(
      taskId: string,
      patch: { cavemanEnabled?: boolean; cavemanLevel?: CavemanLevel },
    ): Promise<void> {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      const previous = {
        cavemanEnabled: task.cavemanEnabled,
        cavemanLevel: task.cavemanLevel,
      };
      Object.assign(task, patch);
      try {
        const updated = await api.updateTask(taskId, patch);
        this.upsertTask(updated);
      } catch (err) {
        Object.assign(task, previous); // rollback
        this.error = errorMessage(err);
        throw err;
      }
    },

    /**
     * Restart a task's agent so a pending caveman change lands. The backend
     * kills the pty; the terminal reconnects and revives it with `--continue`,
     * and the respawn is what re-reads the plugin settings.
     */
    async restartAgent(taskId: string): Promise<void> {
      try {
        const { task } = await api.restartAgent(taskId);
        this.upsertTask(task);
      } catch (err) {
        this.error = errorMessage(err);
        throw err;
      }
    },

    /** Delete a task — triggers the backend teardown (worktrees, pty, branches). */
    async deleteTask(taskId: string): Promise<void> {
      await api.deleteTask(taskId);
      this.removeTaskFromState(taskId);
    },

    /* ── Local reconciliation helpers ─────────────────────────────── */

    upsertProject(project: Project): void {
      const i = this.projects.findIndex((p) => p.id === project.id);
      if (i === -1) this.projects.push(project);
      else this.projects[i] = project;
    },

    upsertTask(task: Task): void {
      const i = this.tasks.findIndex((t) => t.id === task.id);
      if (i === -1) this.tasks.push(task);
      else this.tasks[i] = task;
    },

    /**
     * Drop a task from local state by id. Shared by {@link deleteTask} and the
     * `task:deleted` board event so both reconcile identically.
     */
    removeTaskFromState(taskId: string): void {
      this.tasks = this.tasks.filter((t) => t.id !== taskId);
    },

    /**
     * Drop a project and its tasks from local state, reselecting the first
     * remaining project if the deleted one was active. Shared by
     * {@link deleteProject} and the `project:deleted` board event so both
     * reconcile identically.
     */
    removeProjectFromState(projectId: string): void {
      this.projects = this.projects.filter((p) => p.id !== projectId);
      this.tasks = this.tasks.filter((t) => t.projectId !== projectId);
      if (this.selectedProjectId === projectId) {
        this.selectedProjectId = this.projects[0]?.id ?? null;
      }
    },

    /* ── Live websocket events ────────────────────────────────────── */

    /** Subscribe to /ws/events and reconcile broadcasts into state. */
    connectEvents(): void {
      if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;

      const socket = new WebSocket(eventsWsUrl());
      this.socket = socket;

      socket.onmessage = (ev: MessageEvent<string>) => {
        let raw: unknown;
        try {
          raw = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!isRecord(raw) || raw.type !== "board:event") return;
        this.applyEvent(raw as unknown as BoardEventMsg);
      };

      socket.onclose = () => {
        if (this.socket === socket) {
          this.socket = null;
          // Best-effort reconnect; harmless if the page is unloading.
          window.setTimeout(() => this.connectEvents(), 2000);
        }
      };

      socket.onerror = () => socket.close();
    },

    /** Tear down the events socket (e.g. on app unmount). */
    disconnectEvents(): void {
      const socket = this.socket;
      this.socket = null;
      socket?.close();
    },

    /** Apply a single server board event to local state. */
    applyEvent(event: BoardEventMsg): void {
      switch (event.kind) {
        case "task:created":
        case "task:updated":
        case "task:status":
          if (event.task) this.upsertTask(event.task);
          break;
        case "task:deleted":
          if (event.taskId) this.removeTaskFromState(event.taskId);
          break;
        case "project:created":
        case "project:updated":
          if (event.project) this.upsertProject(event.project);
          break;
        case "project:deleted":
          if (event.projectId) this.removeProjectFromState(event.projectId);
          break;
      }
    },
  },
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Narrow an unknown JSON value to a plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
