/**
 * Interfaces for named-agent discovery and saved routing (SPEC.md
 * "Named-agent discovery" and "Saved routing"). The core
 * run manager does not depend on this module; the spawn tool layer composes
 * discovery + routing + the run manager.
 */

import type { HarnessKind, ThinkingLevel } from "../shared/types.js";

/** Where an agent definition came from, lowest to highest precedence. */
export type AgentScope = "package" | "user" | "project";

export interface AgentSource {
  scope: AgentScope;
  /** Real path of the definition file. */
  path: string;
  /** Declaring package name, for package-scoped agents. */
  packageName?: string;
}

/** Parsed agent definition (Markdown body + YAML frontmatter). */
export interface AgentDefinition {
  name: string;
  description: string;
  /** Markdown body, delivered to the harness as the system prompt. */
  systemPrompt: string;
  /** Optional exact tool allowlist from the agent frontmatter. */
  tools?: string[];
  /** Skill names whose full instructions are preloaded before the task. */
  skills?: string[];
  /** Optional frontmatter defaults, below saved routing in precedence. */
  defaults: {
    harness?: HarnessKind;
    model?: string;
    thinking?: ThinkingLevel;
  };
  source: AgentSource;
}

export interface AgentCatalog {
  /** Deduplicated by name; higher scope replaced lower scope. */
  agents: AgentDefinition[];
  /** Bounded, deduplicated diagnostics (invalid files, collisions, limits). */
  warnings: string[];
}

export interface AgentDiscoveryOptions {
  cwd: string;
  /** Project definitions are ignored when false. */
  projectTrusted: boolean;
}

/**
 * Produces the catalog on demand (subagent_agents, spawn resolution, TUI).
 * Implementations own all filesystem safety rules: realpath containment,
 * symlink rejection, and fixed limits on depth/files/bytes.
 */
export interface AgentDiscovery {
  discover(options: AgentDiscoveryOptions): Promise<AgentCatalog>;
}

/** One saved routing mapping for a named agent. */
export interface RoutingEntry {
  harness?: HarnessKind;
  model?: string;
  thinking?: ThinkingLevel;
  /** Unknown fields survive read/edit/write cycles. */
  [key: string]: unknown;
}

/** On-disk format of subagents.json. Unknown fields are preserved. */
export interface RoutingFile {
  version: 1;
  agents: Record<string, RoutingEntry>;
  [key: string]: unknown;
}

export type RoutingScope = "user" | "project";

export interface RoutingReadResult {
  routing: RoutingFile | undefined;
  /** Bounded description when the file exists but is invalid. */
  invalidReason?: string;
}

/**
 * Atomic, permission-restricted persistence of saved routing
 * (mode 0600 files inside 0700 directories).
 */
export interface RoutingStore {
  read(scope: RoutingScope): Promise<RoutingReadResult>;
  write(scope: RoutingScope, routing: RoutingFile): Promise<void>;
  /** Back up an invalid file and return the backup path (routing UI reset). */
  backupInvalid(scope: RoutingScope): Promise<string>;
}

/** Inputs for resolving one run's effective route. */
export interface RouteResolutionInput {
  /** Explicit spawn arguments: highest precedence. */
  explicit: RoutingEntry;
  /** Selected named agent, when any. */
  agent?: AgentDefinition;
  /**
   * Compatibility input for callers that have already merged saved routing.
   * New callers should pass userRouting/projectRouting so provenance remains
   * exact for each field.
   */
  savedRouting?: RoutingEntry;
  savedRoutingProvenance?: Partial<
    Record<keyof Pick<RoutingEntry, "harness" | "model" | "thinking">, "saved-user" | "saved-project">
  >;
  /** User mapping, below project mapping in precedence. */
  userRouting?: RoutingEntry;
  /** Trusted-project mapping, above user mapping in precedence. */
  projectRouting?: RoutingEntry;
  /** Parent defaults: lowest precedence and inherited by the Pi harness. */
  parent: {
    model: string | undefined;
    thinking: ThinkingLevel | undefined;
  };
}

/** Effective route with per-field provenance for display in the routing UI. */
export interface ResolvedRoute {
  harness: HarnessKind;
  model: string | undefined;
  thinking: ThinkingLevel | undefined;
  provenance: {
    harness: RouteFieldProvenance;
    model: RouteFieldProvenance;
    thinking: RouteFieldProvenance;
  };
}

export type RouteFieldProvenance =
  | "explicit"
  | "saved-project"
  | "saved-user"
  | "agent-default"
  | "parent";

export interface RouteResolver {
  resolve(input: RouteResolutionInput): ResolvedRoute;
}

/** A Pi package installation whose manifest may declare agent directories. */
export interface InstalledAgentPackage {
  /** Stable settings identity, for example `npm:@scope/package@1.2.3`. */
  source: string;
  /** Filesystem package root. It must be a real directory, not a symlink. */
  root: string;
  /** Optional display name; package.json `name` takes precedence when valid. */
  name?: string;
  /** Packages coming from project settings are ignored for untrusted projects. */
  scope?: "user" | "project";
  /** Direct descriptor override used when settings were normalized elsewhere. */
  autoload?: boolean;
}

/** Pi accepts package settings as a source string or a source-bearing object. */
export type PackageSettingInput = string | PackageSettingObject;

export interface PackageSettingObject {
  source: string;
  autoload?: boolean;
  [key: string]: unknown;
}

export interface EffectivePackageSetting extends PackageSettingObject {
  scope: "user" | "project";
  order: number;
}

export interface PackageSettingsByScope {
  user?: readonly unknown[];
  project?: readonly unknown[];
  projectTrusted: boolean;
}
