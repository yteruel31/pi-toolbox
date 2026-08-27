#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_TOKEN_OUTPUT_BYTES = 16 * 1024;
const TOKEN_TIMEOUT_MS = 10_000;
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n");
const TOKEN_ENV_PATTERN = /sonar.*token|token.*sonar/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string") ? value : undefined;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Sonar configuration requires ${name}`);
  return value.trim();
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  return value.startsWith(`~${path.sep}`) ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
}

export function parseSonarProperties(text) {
  const properties = {};
  let continued = "";
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = continued + sourceLine.trim();
    if (line.endsWith("\\") && !line.endsWith("\\\\")) {
      continued = line.slice(0, -1);
      continue;
    }
    continued = "";
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = line.search(/(?<!\\)[=:]/);
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) properties[key] = value;
  }
  return properties;
}

export async function loadSonarAdapterConfig(configPath, root) {
  if ((await stat(configPath)).size > MAX_CONFIG_BYTES) throw new Error("Sonar configuration exceeds 1MB");
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  const raw = isRecord(parsed) && isRecord(parsed.sonarqube) ? parsed.sonarqube : undefined;
  if (!raw || raw.enabled !== true) throw new Error("SonarQube integration is not enabled in user configuration");
  if (!isRecord(raw.connection)) throw new Error("SonarQube integration requires a user-configured connection");

  const provider = raw.connection.provider ?? "sonarcloud";
  if (provider !== "sonarcloud") throw new Error("Only SonarQube Cloud connections are currently supported");
  const organizationKey = requiredString(raw.connection.organizationKey, "connection.organizationKey");
  const region = requiredString(raw.connection.region ?? "EU", "connection.region").toUpperCase();
  if (region !== "EU" && region !== "US") throw new Error("SonarQube Cloud region must be EU or US");
  const connectionId = requiredString(raw.connection.connectionId ?? `sonarcloud-${organizationKey}`, "connection.connectionId");
  const tokenCommand = stringArray(raw.connection.tokenCommand);
  const tokenEnv = typeof raw.connection.tokenEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.connection.tokenEnv)
    ? raw.connection.tokenEnv
    : undefined;
  if (!tokenCommand && !tokenEnv) throw new Error("SonarQube connection requires tokenCommand or tokenEnv in user configuration");

  const propertiesPath = path.join(root, "sonar-project.properties");
  const properties = parseSonarProperties(await readFile(propertiesPath, "utf8"));
  const projectKey = requiredString(properties["sonar.projectKey"], "sonar.projectKey");
  const projectOrganization = properties["sonar.organization"];
  if (projectOrganization && projectOrganization !== organizationKey) {
    throw new Error("SonarQube project organization does not match the user-configured connection");
  }

  return {
    connection: { provider, connectionId, organizationKey, region, tokenCommand, tokenEnv },
    projectKey,
    propertiesPath,
    focusOnNewCode: raw.focusOnNewCode === true,
    runtimeDir: typeof raw.runtimeDir === "string" ? expandHome(raw.runtimeDir) : undefined,
    jgitWorktreeSupport: raw.jgitWorktreeSupport === true,
    jgitJar: typeof raw.jgitJar === "string" ? expandHome(raw.jgitJar) : undefined,
  };
}

function findExecutable(directory, executableName) {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === executableName && path.basename(path.dirname(candidate)) === "bin") return candidate;
    }
  }
  return undefined;
}

export async function resolveSonarRuntime(runtimeDir, jgitJar) {
  const serverJar = path.join(runtimeDir, "server", "sonarlint-ls.jar");
  const eslintBridge = path.join(runtimeDir, "eslint-bridge");
  const analyzerDir = path.join(runtimeDir, "analyzers");
  const java = findExecutable(path.join(runtimeDir, "jre"), process.platform === "win32" ? "java.exe" : "java");
  if (!java || !existsSync(serverJar) || !existsSync(eslintBridge)) throw new Error("Installed SonarQube for IDE runtime is incomplete");
  const analyzers = (await readdir(analyzerDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jar"))
    .map((entry) => path.join(analyzerDir, entry.name))
    .sort();
  if (analyzers.length === 0) throw new Error("Installed SonarQube runtime has no analyzers");
  if (jgitJar && !existsSync(jgitJar)) throw new Error("Configured JGit worktree override is not installed");
  return { java, serverJar, eslintBridge, analyzers, jgitJar };
}

export function createSonarProtocolConfig(config, runtime) {
  const cloudConnection = {
    connectionId: config.connection.connectionId,
    organizationKey: config.connection.organizationKey,
    region: config.connection.region,
    disableNotifications: true,
  };
  const connections = { sonarqube: [], sonarcloud: [cloudConnection] };
  const project = { connectionId: config.connection.connectionId, projectKey: config.projectKey };
  const sonarlint = {
    automaticAnalysis: true,
    focusOnNewCode: config.focusOnNewCode,
    pathToNodeExecutable: process.execPath,
    connectedMode: { connections, project },
  };
  return {
    initializationOptions: {
      productKey: "pi-lsp",
      productName: "Pi LSP",
      productVersion: "1",
      firstSecretDetected: false,
      showVerboseLogs: false,
      platform: process.platform,
      architecture: process.arch,
      additionalAttributes: {},
      enableNotebooks: false,
      clientNodePath: process.execPath,
      eslintBridgeServerPath: runtime.eslintBridge,
      connections,
      rules: {},
      focusOnNewCode: config.focusOnNewCode,
      automaticAnalysis: true,
    },
    settings: { sonarlint, "files.exclude": {} },
    expectedTokenIdentity: `${config.connection.region}_${config.connection.organizationKey}`,
  };
}

class MessageFramer {
  buffer = Buffer.alloc(0);

  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("Sonar LSP header exceeds 8KB");
        return messages;
      }
      if (headerEnd > MAX_HEADER_BYTES) throw new Error("Sonar LSP header exceeds 8KB");
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + HEADER_SEPARATOR.length);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) throw new Error("Sonar LSP message exceeds 10MB");
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return messages;
      const body = this.buffer.subarray(bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);
      messages.push(JSON.parse(body.toString("utf8")));
    }
    return messages;
  }
}

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

function requestedIdentity(params) {
  if (Array.isArray(params)) return params[0];
  if (typeof params === "string") return params;
  if (isRecord(params)) return params.serverId ?? params.connectionId ?? params.organizationKey;
  return undefined;
}

export function createSonarRequestHandler({ config, protocol, openUris, runCredentialCommand = execFileAsync }) {
  let cachedToken;
  const readToken = async () => {
    if (cachedToken) return cachedToken;
    cachedToken = (async () => {
      if (config.connection.tokenCommand) {
        const [command, ...args] = config.connection.tokenCommand;
        const { stdout } = await runCredentialCommand(command, args, {
          cwd: os.homedir(),
          env: process.env,
          timeout: TOKEN_TIMEOUT_MS,
          maxBuffer: MAX_TOKEN_OUTPUT_BYTES,
          windowsHide: true,
        });
        const token = String(stdout).trim().split(/\r?\n/, 1)[0];
        if (!token) throw new Error("Credential command returned no token");
        return token;
      }
      const token = process.env[config.connection.tokenEnv]?.trim();
      if (!token) throw new Error("Configured Sonar token environment variable is empty");
      return token;
    })();
    try {
      return await cachedToken;
    } catch (error) {
      cachedToken = undefined;
      throw error;
    }
  };

  return async (method, params) => {
    if (method === "workspace/configuration") {
      const items = isRecord(params) && Array.isArray(params.items) ? params.items : [];
      return items.map((item) => isRecord(item) ? protocol.settings[item.section] ?? null : null);
    }
    if (method === "sonarlint/getTokenForServer") {
      if (requestedIdentity(params) !== protocol.expectedTokenIdentity) throw new Error("Unexpected Sonar credential identity");
      return readToken();
    }
    if (method === "sonarlint/isOpenInEditor") {
      const uri = Array.isArray(params) ? params[0] : isRecord(params) ? params.fileUri ?? params.uri : undefined;
      return typeof uri === "string" ? openUris.has(uri) : false;
    }
    if (method === "sonarlint/shouldAnalyseFile") return { shouldBeAnalysed: true };
    if (method === "sonarlint/listFilesInFolder") {
      return { foundFiles: [{ fileName: path.basename(config.propertiesPath), filePath: config.propertiesPath, content: await readFile(config.propertiesPath, "utf8") }] };
    }
    if (method === "sonarlint/filterOutExcludedFiles") {
      return { fileUris: isRecord(params) && Array.isArray(params.fileUris) ? params.fileUris : [] };
    }
    if (method === "sonarlint/canShowMissingRequirementsNotification") return "never_again";
    if (method === "sonarlint/isIgnoredByScm" || method === "sonarlint/hasJoinedIdeLabs" || method === "sonarlint/askSslCertificateConfirmation") return false;
    throw Object.assign(new Error(`Unsupported Sonar request: ${method}`), { code: -32601 });
  };
}

export function sanitizedChildEnvironment(config, environment = process.env) {
  const sanitized = { ...environment };
  for (const key of Object.keys(sanitized)) {
    if (TOKEN_ENV_PATTERN.test(key) || key === config.connection.tokenEnv) delete sanitized[key];
  }
  return sanitized;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --config and --runtime arguments");
    values[key.slice(2)] = value;
  }
  if (!values.config || !values.runtime) throw new Error("Expected --config and --runtime arguments");
  return values;
}

export async function runSonarAdapter(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const root = process.cwd();
  const config = await loadSonarAdapterConfig(args.config, root);
  const runtime = await resolveSonarRuntime(args.runtime, args.jgit);
  const protocol = createSonarProtocolConfig(config, runtime);
  const openUris = new Set();
  const requestHandler = createSonarRequestHandler({ config, protocol, openUris });
  const javaArgs = runtime.jgitJar
    ? ["-Dsonarlint.telemetry.disabled=true", "-cp", `${runtime.jgitJar}${path.delimiter}${runtime.serverJar}`, "org.sonarsource.sonarlint.ls.ServerMain"]
    : ["-Dsonarlint.telemetry.disabled=true", "-jar", runtime.serverJar];
  javaArgs.push("-stdio", "-analyzers", ...runtime.analyzers);
  const child = spawn(runtime.java, javaArgs, { cwd: root, env: sanitizedChildEnvironment(config), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const clientFramer = new MessageFramer();
  const serverFramer = new MessageFramer();
  const respond = (id, result, error) => child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));

  process.stdin.on("data", (chunk) => {
    try {
      for (const message of clientFramer.push(chunk)) {
        const uri = message.params?.textDocument?.uri;
        if (message.method === "textDocument/didOpen" && typeof uri === "string") openUris.add(uri);
        if (message.method === "textDocument/didClose" && typeof uri === "string") openUris.delete(uri);
        if (message.method === "initialize" && isRecord(message.params)) {
          message.params.initializationOptions = { ...(isRecord(message.params.initializationOptions) ? message.params.initializationOptions : {}), ...protocol.initializationOptions };
        }
        child.stdin.write(encodeMessage(message));
      }
    } catch {
      child.kill("SIGKILL");
    }
  });
  child.stdout.on("data", (chunk) => {
    try {
      for (const message of serverFramer.push(chunk)) {
        const intercepted = message.id !== undefined && (message.method === "workspace/configuration" || message.method?.startsWith("sonarlint/"));
        if (!intercepted) {
          process.stdout.write(encodeMessage(message));
          continue;
        }
        void requestHandler(message.method, message.params).then(
          (result) => respond(message.id, result),
          (error) => respond(message.id, undefined, { code: typeof error?.code === "number" ? error.code : -32001, message: error?.code === -32601 ? error.message : "Sonar adapter request failed" }),
        );
      }
    } catch {
      child.kill("SIGKILL");
    }
  });
  process.stdin.on("end", () => child.stdin.end());
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("error", (error) => {
    process.stdin.pause();
    process.stderr.write(`Unable to start SonarQube language server: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.stdin.pause();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  runSonarAdapter().catch((error) => {
    process.stderr.write(`SonarQube adapter failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
