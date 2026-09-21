import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import type { Candidate, Decision } from "./types.js";
import { canonicalPath, canonicalShellPath, within } from "./policies.js";
import { analyzeShell, destinationChild, parseOperands, parseSedOperands, shellPathUsable, type ShellSegment } from "./shell-analysis.js";

export type DeterministicVerdict = "Allow" | "Ask" | "Deny" | undefined;
type Segment = ShellSegment;

const sensitive = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.ssh(?:\/|$)|\.aws(?:\/|$)|\.kube(?:\/|$)|id_(?:rsa|ed25519)(?:\.pub)?$|credentials(?:\.[^/]*)?$|auth\.json$|[^/]*\.(?:pem|key|p12|pfx)$)/i;
const protectedBranches = new Set(["main", "master"]);

function decision(action: Exclude<DeterministicVerdict, undefined>, id: string, reason: string): Decision {
  return { action, origin: "policy", reason, policyIds: [id], historyIds: [] };
}

function expand(path: string): string { return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path; }
function canonical(path: string, cwd: string): string { return canonicalPath(expand(path), cwd); }
function shellCanonical(path: string, cwd: string): string { return canonicalShellPath(expand(path), cwd); }
function isSensitivePath(path: string, cwd: string, shell = false): boolean { return sensitive.test((shell ? shellCanonical : canonical)(path, cwd).replaceAll(sep, "/")); }
function isDevice(path: string, cwd: string, shell = false): boolean { return /^\/dev(?:\/|$)/.test((shell ? shellCanonical : canonical)(path, cwd)); }
function isRootOrHome(path: string, cwd: string, shell = false): boolean { const absolute = (shell ? shellCanonical : canonical)(path, cwd); return absolute === "/" || absolute === resolve(homedir()); }

function mutatingPaths(words: string[]): string[] | undefined {
  const [name, ...args] = words; let parsed: ReturnType<typeof parseOperands>;
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred":
      parsed = parseOperands(args, /^(?:-[rfdiIvPRzu]+|--(?:recursive|force|dir|verbose|zero|remove))$/, new Set(["-n", "-s", "--iterations", "--size"])); return parsed?.paths;
    case "touch":
      parsed = parseOperands(args, /^(?:-[acmh]+|--(?:no-create|no-dereference))$/, new Set(["-t", "-d", "-r", "--date", "--reference"])); return parsed?.paths;
    case "truncate":
      parsed = parseOperands(args, /^(?:-[co]+|--(?:no-create|io-blocks))$/, new Set(["-s", "--size", "-r", "--reference"])); return parsed?.paths;
    case "chmod": case "chown": case "chgrp":
      parsed = parseOperands(args, /^(?:-[RcfvhHL]+|--(?:recursive|changes|silent|quiet|verbose|no-dereference))$/, new Set()); return parsed && parsed.paths.slice(1);
    case "tee": parsed = parseOperands(args, /^(?:-[ai]+|--(?:append|ignore-interrupts))$/, new Set()); return parsed?.paths;
    case "cp": case "mv": case "install": case "ln": {
      parsed = parseOperands(args, /^(?:-[rRaAfipnvTsfdbD]+|--(?:recursive|archive|force|no-clobber|no-target-directory|symbolic|directory))$/, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
      if (!parsed) return undefined;
      const sources = parsed.target ? parsed.paths : parsed.paths.slice(0, -1), destination = parsed.target ?? parsed.paths.at(-1);
      if (!destination) return undefined;
      return [...(name === "mv" ? sources : []), destination, ...sources.map((source) => destinationChild(destination, source))];
    }
    case "sed": {
      const sed = parseSedOperands(args);
      return sed ? (sed.inPlace ? sed.paths : []) : undefined;
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
  if (["echo", "cat", "head", "tail", "stat", "wc", "grep", "rg", "ls", "test", "["].includes(name)) {
    const allowed: Record<string, RegExp> = {
      cat: /^(?:--|-n|-b|-s|-E|-T|-A)$/, head: /^(?:--|-q|-v|-n\d*|-c\d*)$/, tail: /^(?:--|-q|-v|-n\d*|-c\d*)$/,
      echo: /^(?:--|-n|-e|-E|-[neE]+)$/, stat: /^(?:--|-L|-f|-c.*|--format=.*|--printf=.*)$/, wc: /^(?:--|-[clmwL]+)$/, grep: /^(?:--|-[EinclHhsv]+|-e|-f|-e.+|-f.+)$/, rg: /^(?:--|-[inl]+|--(?:hidden|no-ignore|files))$/,
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


function readPaths(words: string[]): string[] | undefined {
  const [name, ...args] = words;
  if (["echo", "printf", "pwd", "true", "false", ":"].includes(name)) return [];
  if (name === "git") {
    let i = 0;
    while (i < args.length && args[i].startsWith("-")) i++;
    const sub = args[i++];
    if (sub === "show") {
      const operands = args.slice(i).filter((arg) => !arg.startsWith("-"));
      if (operands.length !== 1) return undefined;
      const colon = operands[0].indexOf(":");
      return colon >= 0 && operands[0].slice(colon + 1) ? [operands[0].slice(colon + 1)] : undefined;
    }
    if (sub === "diff") {
      const separator = args.indexOf("--", i);
      if (separator < 0 || separator === args.length - 1) return undefined;
      return args.slice(separator + 1);
    }
    return ["status", "rev-parse"].includes(sub ?? "") ? [] : undefined;
  }
  if (name === "grep") {
    const optionFiles = args.filter((arg) => /^-f.+/.test(arg)).map((arg) => arg.slice(2));
    const hasOptionPattern = args.some((arg) => arg === "-e" || arg === "--regexp" || arg === "-f" || arg === "--file" || /^-(?:e|f).+/.test(arg) || /^--(?:regexp|file)=.+/.test(arg));
    const parsed = parseOperands(args, /^(?:--|-[EinclHhsv]+|-e.+|-f.+)$/, new Set(["-e", "--regexp", "-f", "--file"]));
    if (!parsed) return undefined;
    const separateFiles: string[] = [];
    for (let i = 0; i < args.length; i++) if ((args[i] === "-f" || args[i] === "--file") && args[i + 1]) separateFiles.push(args[++i]);
    return [...parsed.paths.slice(hasOptionPattern ? 0 : 1), ...optionFiles, ...separateFiles];
  }
  if (["cat", "head", "tail", "stat", "wc", "rg", "ls", "test", "["].includes(name)) return args.filter((arg) => !arg.startsWith("-"));
  return [];
}

function evaluateParsed(parsed: Segment[], complete: boolean, uncertainCwd: boolean[], c: Candidate): Decision | undefined {
  let allSafe = complete && parsed.length > 0 && parsed.length === 1, ask = false;
  for (let index = 0; index < parsed.length; index++) {
    const { words, redirections } = parsed[index];
    const usable = (path: string) => shellPathUsable(path, uncertainCwd[index]);
    if (redirections.some((r) => r.operator !== "<")) allSafe = false;
    for (const redirection of redirections) {
      if (!usable(redirection.path)) { allSafe = false; continue; }
      if (redirection.operator === "<") { if (isSensitivePath(redirection.path, c.cwd, true)) ask = true; continue; }
      if (isSensitivePath(redirection.path, c.cwd, true) || isDevice(redirection.path, c.cwd, true) || isRootOrHome(redirection.path, c.cwd, true)) return decision("Deny", "builtin.dangerous-path", "Shell writes to credential, device, root or home targets are denied.");
    }
    if (!words.length) continue;
    if (/^mkfs(?:\.|$)/.test(words[0])) return decision("Deny", "builtin.catastrophic-shell", "Disk formatting is denied.");
    if (gitDestructive(words)) return decision("Deny", "builtin.protected-branch", "Destructive Git operations targeting main or master are denied.");
    const paths = mutatingPaths(words);
    if (paths === undefined) { allSafe = false; continue; }
    if (paths.filter(usable).some((path) => isSensitivePath(path, c.cwd, true) || isDevice(path, c.cwd, true))) return decision("Deny", "builtin.dangerous-path", "Mutation of an identified credential or device path is denied.");
    if (["rm", "rmdir", "unlink", "shred", "truncate", "dd"].includes(words[0]) && paths.filter(usable).some((path) => isRootOrHome(path, c.cwd, true))) return decision("Deny", "builtin.catastrophic-shell", "Destructive mutation of the filesystem root or home directory is denied.");
    const safe = safeRead(words);
    const reads = safe ? readPaths(words) : undefined;
    if (!safe || reads === undefined) allSafe = false;
    if (reads?.filter(usable).some((path) => isSensitivePath(path, c.cwd, true))) ask = true;
  }
  if (ask) return decision("Ask", "builtin.sensitive-path", "Reading an identified credential path requires review.");
  return allSafe ? decision("Allow", "builtin.safe-read", "Narrow read-only shell form recognized.") : undefined;
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
      if (target !== project && within(project, target) && !protectedPaths.some((p) => within(canonical(p, c.cwd), target))) return decision("Allow", "builtin.project-write", "Write target is inside the project and outside protected or sensitive paths.");
    }
    return undefined;
  }
  const analysis = analyzeShell(String(c.args.command ?? ""));
  const result = evaluateParsed(analysis.segments, analysis.complete, analysis.uncertainCwd, c);
  return result?.action === "Allow" && !analysis.complete ? undefined : result;
}
