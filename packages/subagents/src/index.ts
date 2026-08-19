/** Public entry point for the extension factory and reusable contracts. */

// Pi extension entry point
export { createPiSubagentsExtension, default } from "./extension.js";

// Core
export { RunManager } from "./core/run-manager.js";
export type {
  RunManagerHooks,
  RunManagerOptions,
  SpawnRunRequest,
  WaitOptions,
} from "./core/run-manager.js";
export type {
  HarnessActiveControl,
  HarnessResolver,
  HarnessRunOutcome,
  HarnessRunRequest,
  SubagentHarness,
} from "./core/harness.js";

// Harnesses
export {
  ClaudeHarness,
  aggregateClaudeUsage,
  buildClaudeOptions,
  classifyClaudeFailure,
  createDefaultClaudeQueryFactory,
  mapThinkingLevel,
  normalizeClaudeModel,
} from "./harnesses/claude.js";
export type {
  ClaudeAssistantMessage,
  ClaudeEffortLevel,
  ClaudeHarnessOptions,
  ClaudeModelUsage,
  ClaudeQuery,
  ClaudeQueryFactory,
  ClaudeQueryFunction,
  ClaudeQueryOptions,
  ClaudeResultMessage,
  ClaudeSdkMessage,
  ClaudeSdkUserInput,
  ClaudeUserMessage,
  ClaudeStreamEventMessage,
  ClaudeSystemMessage,
  ClaudeToolProgressMessage,
} from "./harnesses/claude.js";
export {
  PI_CHILD_EXCLUDED_TOOLS,
  PI_TOOL_WATCHDOG_MS,
  PiHarness,
  createOfficialPiResources,
  createOfficialPiSession,
  isExcludedPiChildTool,
} from "./harnesses/pi.js";
export type {
  PiHarnessOptions,
  PiModelLike,
  PiModelRuntimeLike,
  PiResourceContext,
  PiResourceFactory,
  PiResourceFactoryInput,
  PiSessionCreateInput,
  PiSessionEvent,
  PiSessionFactory,
  PiSessionLike,
} from "./harnesses/pi.js";

// Shared types
export {
  isSettledStatus,
} from "./shared/types.js";
export type {
  CancelEntry,
  CancelReport,
  HarnessKind,
  PersistedRunRecord,
  PersistedRunState,
  ResultConsumption,
  RunActivityEntry,
  RunInspection,
  RunListEntry,
  RunResult,
  RunSnapshot,
  RunStatus,
  RunTranscriptEntry,
  RunTranscriptInput,
  RunMessagingState,
  RunUsage,
  SettledRunStatus,
  ThinkingLevel,
  WaitEntry,
  WaitReport,
} from "./shared/types.js";

// Shared errors and utilities
export {
  ConcurrencyLimitError,
  InvalidArgumentError,
  SubagentError,
  UnknownRunError,
  WaitAbortedError,
  describeError,
} from "./shared/errors.js";
export {
  sanitizeTerminalText,
  truncateText,
  toDisplayTitle,
} from "./shared/truncate.js";
export { BoundedLog } from "./shared/bounded-log.js";

// Pure TUI reducers, view models, and adapter contracts
export * from "./tui/binding.js";
export * from "./tui/command-mode.js";
export * from "./tui/keys.js";
export * from "./tui/pi-views.js";
export * from "./tui/routing-view.js";
export * from "./tui/runs-view.js";
export * from "./tui/status.js";
export * from "./tui/summaries.js";
export * from "./tui/text.js";
export * from "./tui/view-models.js";

// Named-agent discovery and saved routing
export {
  FileAgentDiscovery,
  normalizePackageSettings,
} from "./agents/index.js";
export type {
  FileAgentDiscoveryOptions,
  AgentCatalog,
  AgentDefinition,
  AgentDiscovery,
  AgentDiscoveryOptions,
  AgentScope,
  AgentSource,
  EffectivePackageSetting,
  InstalledAgentPackage,
  PackageSettingInput,
  PackageSettingObject,
  PackageSettingsByScope,
  RoutingEntry,
  RoutingFile,
  RoutingReadResult,
  RoutingScope,
  RoutingStore,
} from "./agents/index.js";
export {
  DefaultRouteResolver,
  FileRoutingStore,
  routeResolver,
} from "./agents/index.js";
export type {
  FileRoutingStoreOptions,
  ResolvedRoute,
  RouteFieldProvenance,
  RouteResolutionInput,
  RouteResolver,
} from "./agents/index.js";
