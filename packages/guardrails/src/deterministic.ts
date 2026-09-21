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
    if (quote === "'") { if (ch === "'") quote = ""; else word += ch; continue; }
    if (ch === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      if (next === "\n") continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; continue;
    }
    if (ch === "$" || ch === "`") return undefined;
    if (quote === '"') { if (ch === '"') quote = ""; else word += ch; continue; }
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
    if (token.kind === "operator" && [";", "\n", "&&", "||", "|"].includes(token.value)) { result.push({ words: [], redirections: [] }); continue; }
    if (token.kind === "operator") {
      const target = tokens[++i];
      if (!target || target.kind !== "word") return undefined;
      result.at(-1)!.redirections.push({ operator: token.value, path: target.value });
    } else result.at(-1)!.words.push(token.value);
  }
  return result;
}

function literalSegments(command: string): string[] {
  const result: string[] = [];
  let start = 0, quote = "", escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ";" || ch === "\n") { result.push(command.slice(start, i)); start = i + 1; }
  }
  result.push(command.slice(start));
  return result;
}

function expand(path: string): string { return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path; }
function canonical(path: string, cwd: string): string { return canonicalPath(expand(path), cwd); }
function isSensitivePath(path: string, cwd: string): boolean { return sensitive.test(canonical(path, cwd).replaceAll(sep, "/")); }
function isDevice(path: string, cwd: string): boolean { return /^\/dev(?:\/|$)/.test(canonical(path, cwd)); }
function isRootOrHome(path: string, cwd: string): boolean { const absolute = canonical(path, cwd); return absolute === "/" || absolute === resolve(homedir()); }

function operands(args: string[], flags: RegExp, values: Set<string>): { paths: string[]; target?: string } | undefined {
  const paths: string[] = []; let target: string | undefined, end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === "--") { end = true; continue; }
    if (!end && arg.startsWith("-")) {
      const equal = arg.indexOf("="); const option = equal < 0 ? arg : arg.slice(0, equal);
      if (values.has(option)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value) return undefined;
        if (option === "-t" || option === "--target-directory") target = value;
      } else if (!flags.test(arg)) return undefined;
    } else paths.push(arg);
  }
  return { paths, target };
}

function mutatingPaths(words: string[]): string[] | undefined {
  const [name, ...args] = words; let parsed: ReturnType<typeof operands>;
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred":
      parsed = operands(args, /^(?:-[rfdiIvPRzu]+|--(?:recursive|force|dir|verbose|zero|remove))$/, new Set(["-n", "-s", "--iterations", "--size"])); return parsed?.paths;
    case "touch":
      parsed = operands(args, /^(?:-[acmh]+|--(?:no-create|no-dereference))$/, new Set(["-t", "-d", "-r", "--date", "--reference"])); return parsed?.paths;
    case "truncate":
      parsed = operands(args, /^(?:-[co]+|--(?:no-create|io-blocks))$/, new Set(["-s", "--size", "-r", "--reference"])); return parsed?.paths;
    case "chmod": case "chown": case "chgrp":
      parsed = operands(args, /^(?:-[RcfvhHL]+|--(?:recursive|changes|silent|quiet|verbose|no-dereference))$/, new Set()); return parsed && parsed.paths.slice(1);
    case "tee": parsed = operands(args, /^(?:-[ai]+|--(?:append|ignore-interrupts))$/, new Set()); return parsed?.paths;
    case "cp": case "mv": case "install": case "ln": {
      parsed = operands(args, /^(?:-[rRaAfipnvTsfdbD]+|--(?:recursive|archive|force|no-clobber|no-target-directory|symbolic|directory))$/, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
      if (!parsed) return undefined;
      const sources = parsed.target ? parsed.paths : parsed.paths.slice(0, -1), destination = parsed.target ?? parsed.paths.at(-1);
      if (!destination) return undefined;
      return [...(name === "mv" ? sources : []), destination, ...sources.map((source) => resolve(destination, source.split("/").at(-1)!))];
    }
    case "sed": {
      const inplace = args.some((arg) => arg === "-i" || /^-i.+/.test(arg) || arg.startsWith("--in-place"));
      if (!inplace) return [];
      parsed = operands(args, /^(?:-i.*|--in-place(?:=.*)?)$/, new Set(["-e", "--expression", "-f", "--file"])); return parsed?.paths;
    }
    case "dd": return args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
    default: return [];
  }
}

function gitDestructive(words: string[]): boolean {
  if (words[0] !== "git") return false;
  const args = words.slice(1), valueGlobals = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) break;
    const option = arg.split("=", 1)[0];
    if (valueGlobals.has(option) && !arg.includes("=")) { if (!args[++i]) return false; }
  }
  const command = args[i], rest = args.slice(i + 1);
  if (command === "push") {
    let forced = false, deleting = false; const refs: string[] = [];
    const values = new Set(["--repo", "--receive-pack", "--exec"]); let remoteSkipped = rest.some((arg) => arg === "--repo" || arg.startsWith("--repo="));
    for (let j = 0; j < rest.length; j++) {
      const arg = rest[j]; const option = arg.split("=", 1)[0];
      if (/^--force(?:-with-lease)?(?:=|$)/.test(arg) || /^-[^-]*f/.test(arg)) forced = true;
      if (arg === "--delete" || /^-[^-]*d/.test(arg)) deleting = true;
      if (values.has(option)) { if (!arg.includes("=")) j++; continue; }
      if (arg.startsWith("-")) continue;
      if (!remoteSkipped) { remoteSkipped = true; continue; }
      refs.push(arg);
    }
    return refs.some((ref) => {
      const plus = ref.startsWith("+"); const clean = ref.replace(/^\+/, "");
      const target = clean.split(":").at(-1)!.replace(/^refs\/heads\//, "");
      return protectedBranches.has(target) && (forced || plus || deleting || clean.startsWith(":"));
    });
  }
  if (command === "branch") {
    const deleting = rest.some((arg) => arg === "--delete" || /^-[^-]*[dD]/.test(arg));
    return deleting && rest.some((arg) => protectedBranches.has(arg));
  }
  return false;
}

function safeRead(words: string[]): boolean {
  const [name, ...args] = words;
  if (["pwd", "true", "false", ":"].includes(name)) return args.length === 0;
  if (name === "printf") return args.every((arg) => !arg.startsWith("-") || arg === "--");
  const common = /^(?:--|-[A-Za-z]+)$/;
  if (["cat", "head", "tail", "stat", "wc", "grep", "rg", "ls", "test", "["].includes(name)) {
    const allowed: Record<string, RegExp> = {
      cat: /^(?:--|-n|-b|-s|-E|-T|-A)$/, head: /^(?:--|-q|-v|-n\d*|-c\d*)$/, tail: /^(?:--|-q|-v|-n\d*|-c\d*)$/,
      stat: /^(?:--|-L|-f|-c.*|--format=.*|--printf=.*)$/, wc: /^(?:--|-[clmwL]+)$/, grep: /^(?:--|-[EinclHhsv]+|-e.*|-f.*)$/, rg: /^(?:--|-[inl]+|--(?:hidden|no-ignore|files))$/,
      ls: /^(?:--|-[AacdFfhilLmnopqRrStuUxZ1]+|--color=(?:auto|always|never))$/, test: /^(?:--|-[abcdefghknoprstuw])$/, "[": /^(?:--|-[abcdefghknoprstuw])$/,
    };
    return args.every((arg) => !arg.startsWith("-") || allowed[name].test(arg)) && !args.some((arg) => arg === "-x" || arg === "-X") && common.test("--");
  }
  if (name !== "git") return false;
  const allowedGlobal = /^(?:--no-pager|--literal-pathspecs|--no-optional-locks)$/; let i = 0;
  while (i < args.length && args[i].startsWith("-")) { if (!allowedGlobal.test(args[i])) return false; i++; }
  const sub = args[i++];
  if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(sub ?? "")) return false;
  const allowed = /^(?:--|-[sbwz]|-n\d+|-U\d+|--(?:short|branch|porcelain(?:=v?[12])?|oneline|stat|shortstat|numstat|name-only|name-status|check|cached|staged|no-color|no-ext-diff|no-textconv|show-toplevel|git-common-dir|show-prefix|is-inside-work-tree|verify|abbrev-ref|symbolic-full-name|reverse|all|decorate(?:=(?:short|full|no))?|max-count=\d+|format=.*|pretty=.*))$/;
  return args.slice(i).every((arg) => !arg.startsWith("-") || allowed.test(arg));
}

function evaluateParsed(parsed: Segment[], command: string, c: Candidate): Decision | undefined {
  let allSafe = parsed.length > 0 && !/[;|&\n]/.test(command), ask = false;
  for (const { words, redirections } of parsed) {
    if (redirections.some((r) => r.operator !== "<")) allSafe = false;
    for (const redirection of redirections) {
      if (redirection.operator === "<") { if (isSensitivePath(redirection.path, c.cwd)) ask = true; continue; }
      if (isSensitivePath(redirection.path, c.cwd) || isDevice(redirection.path, c.cwd) || isRootOrHome(redirection.path, c.cwd)) return decision("Deny", "builtin.dangerous-path", "Shell writes to credential, device, root or home targets are denied.");
    }
    if (!words.length) continue;
    if (/^mkfs(?:\.|$)/.test(words[0])) return decision("Deny", "builtin.catastrophic-shell", "Disk formatting is denied.");
    if (gitDestructive(words)) return decision("Deny", "builtin.protected-branch", "Destructive Git operations targeting main or master are denied.");
    const paths = mutatingPaths(words);
    if (paths === undefined) { allSafe = false; continue; }
    if (paths.some((path) => isSensitivePath(path, c.cwd) || isDevice(path, c.cwd))) return decision("Deny", "builtin.dangerous-path", "Mutation of an identified credential or device path is denied.");
    if (["rm", "rmdir", "unlink", "shred", "truncate", "dd"].includes(words[0]) && paths.some((path) => isRootOrHome(path, c.cwd))) return decision("Deny", "builtin.catastrophic-shell", "Destructive mutation of the filesystem root or home directory is denied.");
    const safe = safeRead(words);
    if (paths.length || !safe) allSafe = false;
    if (safe && words.slice(1).some((arg) => !arg.startsWith("-") && isSensitivePath(arg, c.cwd))) ask = true;
  }
  if (ask) return decision("Ask", "builtin.sensitive-path", "Reading an identified credential path requires review.");
  return allSafe ? decision("Allow", "builtin.safe-read", "Narrow read-only shell form recognized.") : undefined;
}

/** Built-in decisions cover only narrow facts that are safe to prove locally. */
export function deterministicDecision(c: Candidate, protectedPaths: string[]): Decision | undefined {
  if (c.tool === "mcp" || c.tool === "web-access") return undefined;
  if (c.tool !== "bash") {
    const path = String(c.args.path ?? "");
    // Resolve each lexical prefix before `..`: resolving the whole string first
    // would erase symlink traversal order and could falsely prove containment.
    const expandedPath = expand(path);
    const parts = expandedPath.split(sep);
    if (parts.some((part, i) => part === ".." && canonical(parts.slice(0, i).join(sep) || ".", c.cwd) !== resolve(c.cwd, parts.slice(0, i).join(sep) || "."))) return undefined;
    if (c.tool === "read" && isSensitivePath(path, c.cwd)) return decision("Ask", "builtin.sensitive-path", "Reading an identified credential path requires review.");
    if ((c.tool === "write" || c.tool === "edit") && (isSensitivePath(path, c.cwd) || isDevice(path, c.cwd))) return decision("Deny", "builtin.dangerous-path", "Writing an identified credential or device path is denied.");
    if (c.tool === "write" || c.tool === "edit") {
      const target = canonical(path, c.cwd), project = canonical(c.project, c.cwd);
      if (target !== project && within(project, target) && !protectedPaths.some((p) => within(canonical(p, c.cwd), target))) return decision("Allow", "builtin.project-write", "Write target is inside the project and outside protected or sensitive paths.");
    }
    return undefined;
  }
  const command = String(c.args.command ?? ""), parsed = segments(command);
  if (parsed) return evaluateParsed(parsed, command, c);
  // Recover only independently separated literal commands. A proven denial dominates
  // unsupported syntax elsewhere; this never turns recovered fragments into an Allow.
  for (const part of literalSegments(command)) {
    const fragment = segments(part);
    if (!fragment) continue;
    const result = evaluateParsed(fragment, part, c);
    if (result?.action === "Deny") return result;
  }
  return undefined;
}
