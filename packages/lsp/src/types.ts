export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface LocationLink {
  targetUri: string;
  targetRange: Range;
  targetSelectionRange: Range;
  originSelectionRange?: Range;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

export interface TextDocumentEdit {
  textDocument: { uri: string; version?: number | null };
  edits: Array<TextEdit | { range: Range; newText: string; insertTextFormat?: number }>;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | Record<string, unknown>>;
}

export interface DiagnosticRelatedInformation {
  location: Location;
  message: string;
}

export interface Diagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  source?: string;
  message: string;
  relatedInformation?: DiagnosticRelatedInformation[];
}

export interface MarkupContent {
  kind: "plaintext" | "markdown";
  value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

export interface DocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

export interface SymbolInformation {
  name: string;
  kind: number;
  location: Location;
  containerName?: string;
}

export interface ServerFeatures {
  diagnostics: boolean;
  semantics: boolean;
}

export interface ServerDefinition {
  name: string;
  command: string;
  args: string[];
  fileTypes: string[];
  rootMarkers: string[];
  languageIds: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  disabled?: boolean;
  priority: number;
  features: ServerFeatures;
}

export interface DiagnosticsConfig {
  enabled: boolean;
  inlineTimeoutMs: number;
  deferredTimeoutMs: number;
  maxDiagnostics: number;
}

export interface LspConfig {
  servers: ServerDefinition[];
  diagnostics: DiagnosticsConfig;
  idleTimeoutMs: number;
  requestTimeoutMs: number;
  initFailureBackoffMs: number;
  warnings: string[];
}

export interface ResolvedServer {
  definition: ServerDefinition;
  command: string;
  root: string;
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  information: number;
  hints: number;
}

export interface DiagnosticCardData {
  file: string;
  server: string;
  delayed: boolean;
  cleared: boolean;
  counts: DiagnosticCounts;
  diagnostics: Diagnostic[];
  omitted: number;
}

export interface LspToolDetails {
  action: string;
  summary: string;
  lines: string[];
  applied?: boolean;
  error?: string;
}

export interface PublishedDiagnostics {
  diagnostics: Diagnostic[];
  generation: number;
  version?: number;
}

export interface DiagnosticServerFailure {
  server: string;
  message: string;
}

export interface AggregatedDiagnostics {
  servers: string[];
  diagnostics: Diagnostic[];
  complete: boolean;
  failures: DiagnosticServerFailure[];
}

export type JsonRpcId = string | number;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}
