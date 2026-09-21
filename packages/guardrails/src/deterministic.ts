import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Candidate, Decision } from "./types.js";
import { canonicalPath, within } from "./policies.js";

export type DeterministicVerdict = "Allow" | "Ask" | "Deny" | undefined;
type Token = { kind: "word" | "operator"; value: string };
type Segment = { words: string[]; redirections: Array<{ operator: string; path: string }> };

const sensitive = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.kube(?:\/|$)|id_(?:rsa|ed25519)(?:\.pub)?$|credentials(?:\.[^/]*)?$|auth\.json$|[^/]*\.(?:pem|key|p12|pfx)$)/i;
const protectedBranches = new Set(["main", "master"]);

function decision(action: Exclude<DeterministicVerdict, undefined>, id: string, reason: string): Decision {
  return { action, origin: "policy", reason, policyIds: [id], historyIds: [] };
}

/** Parse only literal shell words, simple lists/pipelines and ordinary redirections. */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "", started = false, quote = "";
  const flush = (ioNumber = false) => {
    if (started && !(ioNumber && /^\d+$/.test(word))) tokens.push({ kind: "word", value: word });
    word = ""; started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "'") quote = ""; else word += ch;
      continue;
    }
    if (ch === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      if (next === "\n") continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; continue;
    }
    if (ch === "$" || ch === "`") return undefined;
    if (quote === '"') {
      if (ch === '"') quote = ""; else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; continue; }
    if ("(){}*?[]".includes(ch) || ch === "\r" || ch === "\0") return undefined;
    if (ch === "#" && !started) { while (i + 1 < command.length && command[i + 1] !== "\n") i++; continue; }
    if (";|&<>\n".includes(ch)) {
      flush(ch === "<" || ch === ">");
      let op = ch;
      if (["&&", "||", ">>", ">|", "<>", "&>"].includes(ch + command[i + 1])) op += command[++i];
      if (op === "&" || (ch === "<" && command[i + 1] === "<") || ((ch === ">" || ch === "<") && command[i + 1] === "&")) return undefined;
      tokens.push({ kind: "operator", value: op }); continue;
    }
    if (ch === " " || ch === "\t") { flush(); continue; }
    if (/\s/.test(ch)) return undefined;
    word += ch; started = true;
  }
  if (quote) return undefined;
  flush();
  return tokens;
}

function segments(command: string): Segment[] | undefined {
  const tokens = tokenize(command);
  if (!tokens) return undefined;
  const result: Segment[] = [{ words: [], redirections: [] }];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "operator" && [";", "\n", "&&", "||", "|"].includes(token.value)) {
      result.push({ words: [], redirections: [] }); continue;
    }
    if (token.kind === "operator") {
      const target = tokens[++i];
      if (!target || target.kind !== "word") return undefined;
      result.at(-1)!.redirections.push({ operator: token.value, path: target.value });
    } else result.at(-1)!.words.push(token.value);
  }
  return result;
}

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}
function canonical(path: string, cwd: string): string | undefined {
  try { return canonicalPath(expand(path), cwd); } catch { return undefined; }
}
function isSensitivePath(path: string, cwd: string): boolean {
  const absolute = canonical(path, cwd);
  if (!absolute) return false;
  return sensitive.test(absolute.replaceAll(sep, "/"));
}
function isDevice(path: string, cwd: string): boolean {
  const absolute = canonical(path, cwd);
  return Boolean(absolute && /^\/dev(?:\/|$)/.test(absolute));
}
function isRootOrHome(path: string, cwd: string): boolean {
  const absolute = canonical(path, cwd);
  return absolute === "/" || absolute === resolve(homedir());
}
function optionValue(args: string[], names: Set<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const [name, value] = args[i].split("=", 2);
    if (!names.has(name)) continue;
    return value ?? args[i + 1];
  }
  return undefined;
}
function positional(args: string[], valueOptions = new Set<string>()): string[] | undefined {
  const result: string[] = [];
  let end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === "--") { end = true; continue; }
    if (!end && arg.startsWith("-")) {
      const name = arg.split("=", 1)[0];
      if (valueOptions.has(name) && !arg.includes("=")) {
        if (!args[++i]) return undefined;
      }
      continue;
    }
    result.push(arg);
  }
  return result;
}
function mutatingPaths(words: string[]): string[] | undefined {
  const [name, ...args] = words;
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred": case "touch": case "truncate":
      return positional(args, new Set(["-t", "-d", "-r", "-s", "-n", "--date", "--reference", "--size", "--iterations"]));
    case "chmod": case "chown": case "chgrp": {
      const values = positional(args); return values?.slice(1);
    }
    case "tee": return positional(args);
    case "cp": case "mv": case "install": case "ln": {
      const values = positional(args, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
      const target = optionValue(args, new Set(["-t", "--target-directory"]));
      return target ? [target] : values?.length ? [values.at(-1)!] : undefined;
    }
    case "sed": {
      const values = positional(args, new Set(["-e", "--expression", "-f", "--file"]));
      return args.some((arg) => arg === "-i" || arg.startsWith("-i") || arg.startsWith("--in-place")) ? values?.slice(1) : [];
    }
    case "dd": return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
    default: return [];
  }
}
function gitDestructive(words: string[]): boolean {
  if (words[0] !== "git") return false;
  const args = words.slice(1);
  const commandIndex = args.findIndex((arg) => !arg.startsWith("-") && (arg !== "-C" && args[args.indexOf(arg) - 1] !== "-C"));
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  const rest = commandIndex >= 0 ? args.slice(commandIndex + 1) : [];
  if (command === "push") {
    const forced = rest.some((arg) => /^--force(?:-with-lease)?(?:=|$)/.test(arg) || /^-[^-]*f/.test(arg));
    const refs = rest.filter((arg) => !arg.startsWith("-")).slice(1).map((arg) => arg.replace(/^\+/, "").split(":").at(-1)!.replace(/^refs\/heads\//, ""));
    return forced && refs.some((ref) => protectedBranches.has(ref));
  }
  return command === "branch" && rest.some((arg) => /^-[^-]*D/.test(arg) || arg === "--delete") && rest.some((arg) => protectedBranches.has(arg));
}
function safeRead(words: string[]): boolean {
  const [name, ...args] = words;
  if (name === "pwd" || name === "true" || name === "false" || name === ":") return args.every((arg) => !arg.startsWith("-"));
  if (name === "printf") return !args.some((arg) => arg === "-v" || arg.startsWith("-v") || arg.startsWith("--"));
  if (["ls", "cat", "head", "tail", "stat", "wc", "grep"].includes(name)) return !args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (name === "rg") return !args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (name === "test" || name === "[") return !args.some((arg) => arg === "-x" || arg === "-X");
  if (name !== "git") return false;
  const sub = args.find((arg) => !arg.startsWith("-"));
  if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(sub ?? "")) return false;
  return !args.some((arg) => /^--(?:out(?:put)?|ext-diff|textconv)(?:=|$)/.test(arg));
}

/** Built-in decisions cover only narrow facts that are safe to prove locally. */
export function deterministicDecision(c: Candidate, protectedPaths: string[]): Decision | undefined {
  if (c.tool === "mcp" || c.tool === "web-access") return undefined;
  if (c.tool !== "bash") {
    const path = String(c.args.path ?? "");
    if (c.tool === "read" && isSensitivePath(path, c.cwd)) return decision("Ask", "builtin.sensitive-path", "Reading an identified credential path requires review.");
    if ((c.tool === "write" || c.tool === "edit") && (isSensitivePath(path, c.cwd) || isDevice(path, c.cwd))) return decision("Deny", "builtin.dangerous-path", "Writing an identified credential or device path is denied.");
    if (c.tool === "write" || c.tool === "edit") {
      const target = canonical(path, c.cwd), project = canonical(c.project, c.cwd);
      if (target && project && target !== project && within(project, target) && !protectedPaths.some((p) => { const root = canonical(p, c.cwd); return root && within(root, target); })) {
        return decision("Allow", "builtin.project-write", "Write target is inside the project and outside protected or sensitive paths.");
      }
    }
    return undefined;
  }
  const command = String(c.args.command ?? "");
  const parsed = segments(command);
  if (!parsed) return undefined;
  let allSafe = parsed.length > 0 && !/[;|&\n]/.test(command);
  for (const segment of parsed) {
    const { words, redirections } = segment;
    if (redirections.some((r) => r.operator !== "<")) allSafe = false;
    for (const redirection of redirections) {
      if (redirection.operator !== "<" && (isSensitivePath(redirection.path, c.cwd) || isDevice(redirection.path, c.cwd) || isRootOrHome(redirection.path, c.cwd))) {
        return decision("Deny", "builtin.dangerous-path", "Shell writes to credential, device, root or home targets are denied.");
      }
    }
    if (!words.length) continue;
    if (/^mkfs(?:\.|$)/.test(words[0])) return decision("Deny", "builtin.catastrophic-shell", "Disk formatting is denied.");
    if (gitDestructive(words)) return decision("Deny", "builtin.protected-branch", "Destructive Git operations targeting main or master are denied.");
    const paths = mutatingPaths(words);
    if (paths === undefined) { allSafe = false; continue; }
    if (paths.some((path) => isSensitivePath(path, c.cwd) || isDevice(path, c.cwd))) return decision("Deny", "builtin.dangerous-path", "Mutation of an identified credential or device path is denied.");
    if (["rm", "rmdir", "unlink", "shred", "truncate", "dd"].includes(words[0]) && paths.some((path) => isRootOrHome(path, c.cwd))) {
      return decision("Deny", "builtin.catastrophic-shell", "Destructive mutation of the filesystem root or home directory is denied.");
    }
    if (paths.length || !safeRead(words)) allSafe = false;
    if (safeRead(words) && words.slice(1).some((arg) => isSensitivePath(arg, c.cwd))) {
      return decision("Ask", "builtin.sensitive-path", "Reading an identified credential path requires review.");
    }
  }
  return allSafe ? decision("Allow", "builtin.safe-read", "Narrow read-only shell form recognized.") : undefined;
}
