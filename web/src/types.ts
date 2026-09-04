/**
 * Frontend type surface.
 *
 * Re-exports the shared contracts so components and the store import every
 * domain/DTO/WS type from one local module (`@/types`). If the frontend ever
 * needs a UI-only type, add it here without touching the shared source of truth.
 */
export type {
  Project,
  ProjectRepo,
  Task,
  TaskRepo,
  TaskStatus,
  AgentState,
  CavemanLevel,
  AddRepoDTO,
  CreateProjectRepoDTO,
  CreateProjectDTO,
  CreateTaskDTO,
  UpdateTaskDTO,
  PtyOutputMsg,
  PtyInputMsg,
  PtyResizeMsg,
  PtyExitMsg,
  PtyMessage,
  BoardEventKind,
  BoardEventMsg,
  SchemaField,
  SchemaEntity,
  SchemaRelation,
  SchemaGraph,
  SchemaChange,
  SchemaDiff,
  SchemaScriptInfo,
  TaskSchemaRepo,
  TaskSchemaResponse,
  CodeLocation,
  CodeSuggestion,
  CodeSuggestionKind,
  CodeAdvice,
  CodeFindingKind,
  KnownCodeFindingKind,
  CodeFindingKindInfo,
  CodeFinding,
  CodeFindingHypothesis,
  CodeFindingHypothesisCheck,
  CodeFindingHypothesisLayer,
  CodeFindingHypothesisState,
  PatternConfidence,
  PatternOpportunityPlace,
  CodePatternOpportunity,
  CodeAnalysis,
  CodeFileSummary,
  TaskCodeRepo,
  TaskCodeResponse,
  WSMessage,
  ApiError,
  FsRoot,
  FsEntry,
  FsRootsResponse,
  FsListResponse,
  FsInspectResponse,
} from "@shared/types";

/**
 * RUNTIME re-exports (not types): the caveman level list backing the <select>
 * and the level a freshly ticked checkbox means. Same source of truth the server
 * validates against, so the UI can never offer a level the API rejects.
 */
export { CAVEMAN_LEVELS, CAVEMAN_DEFAULT_LEVEL, cavemanPending } from "@shared/types";

/* ────────────────────────────────────────────────────────────────────────
 * Command panel — SHELL MODEL.
 *
 * The bottom command panel is now a REAL interactive terminal: one persistent
 * shell pty per (taskId, repoId). The Setup/Run/Teardown buttons no longer run
 * their own ptys — they INJECT the configured script into that shell. So there
 * is no per-(repo,kind) running state any more (no CommandStatus / status
 * event); `CommandKind` survives only to pick WHICH script a button injects.
 *
 * `CommandKind` belongs in `@shared/types` (owned by the backend slice). It is
 * re-declared here so the panel/composable type-check standalone with a shape
 * IDENTICAL to the contract.
 * ──────────────────────────────────────────────────────────────────────── */

/** The three lifecycle scripts a repo can inject into its shell as buttons. */
export type CommandKind = "setup" | "run" | "teardown";
