import { basename, isAbsolute, join } from "node:path";

type Token = { kind: "word" | "operator"; value: string };
type Verdict = "Deny" | "Ask" | undefined;
type Touches = (path: string, includeParents?: boolean) => boolean;

/** Only literal words, simple lists/pipelines and file redirections. Never execute or expand input. */
function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = [];
  let word = "", started = false, quote = "", plain = true;
  const flush = (ioNumber = false) => {
    if (started && !(ioNumber && plain && /^\d+$/.test(word))) tokens.push({ kind: "word", value: word });
    word = ""; started = false; plain = true;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "~" && (!word || word.endsWith("="))) return undefined;
      if (ch === "'") quote = ""; else word += ch;
      continue;
    }
    if (ch === "\\") {
      const next = command[++i];
      if (next === undefined || (next === "~" && (!word || word.endsWith("=")))) return undefined;
      if (next === "\n") continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; plain = false; continue;
    }
    // Expansion is executable even inside double-quoted CLI data. Don't strip it.
    if (ch === "$" || ch === "`") return undefined;
    if (quote === '"') {
      if (ch === "~" && (!word || word.endsWith("="))) return undefined;
      if (ch === '"') quote = ""; else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; plain = false; continue; }
    if ("(){}*?[]".includes(ch) || ch === "\r" || ch === "\0") return undefined;
    if (ch === "~" && !word && (started || (command[i + 1] && !/[\s/;|&<>]/.test(command[i + 1])))) return undefined;
    if (ch === "~" && word.endsWith("=") && (!plain || !/^[A-Za-z_][A-Za-z_0-9]*=$/.test(word))) return undefined;
    if (ch === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (";|&<>\n".includes(ch)) {
      flush(ch === "<" || ch === ">");
      let op = ch;
      if (["&&", "||", ">>", ">|", "<>", "&>"].includes(ch + command[i + 1])) op += command[++i];
      // Heredocs, fd duplication, process substitution and background jobs aren't in this grammar.
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

// This is a classification boundary, not an autoapproval list. All other policies still run.
function readOnly(words: string[]): boolean {
  const [name, ...args] = words;
  if (["cat", "head", "tail", "ls", "stat", "pwd", "wc", "echo", "true", "false", ":"].includes(name)) return true;
  if (name === "printf") return !args.some((arg) => arg.startsWith("-v"));
  if (name === "grep") return true;
  if (name === "rg") return !args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg));
  if (name !== "git") return false;
  // Don't accept Git's abbreviated long options: --out can mean --output.
  if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(args[0])) return false;
  const flags = /^(?:--|-[sbwpz]|-n\d*|-U\d+|--(?:short|branch|porcelain(?:=v?[12])?|untracked-files(?:=(?:all|normal|no))?|oneline|stat|shortstat|numstat|name-only|name-status|check|cached|staged|no-color|no-ext-diff|no-textconv|show-toplevel|git-common-dir|show-prefix|is-inside-work-tree|verify|abbrev-ref|symbolic-full-name|reverse|all|decorate(?:=(?:short|full|no))?|max-count=\d+|format=.*|pretty=.*))$/;
  return args.slice(1).every((arg) => !arg.startsWith("-") || flags.test(arg));
}

/** Parse only known option layouts; an unknown option must not hide a destination or a script. */
function operands(args: string[], flags: RegExp, values: Set<string>): { paths: string[]; target?: string } | undefined {
  const paths: string[] = [];
  let target: string | undefined, end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === "--") { end = true; continue; }
    if (!end && arg.startsWith("-")) {
      const equal = arg.indexOf("=");
      const option = equal < 0 ? arg : arg.slice(0, equal);
      if (values.has(option)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value) return undefined;
        if (option === "-t" || option === "--target-directory") target = value;
      } else if (!flags.test(arg)) return undefined;
    } else paths.push(arg);
  }
  return { paths, target };
}

function mutation(words: string[], touches: Touches): Verdict {
  const [name, ...args] = words;
  let parsed: ReturnType<typeof operands>;
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred":
      parsed = operands(args, /^(?:-[rfdiIvPRzun]+|--(?:recursive|force|dir|verbose|zero|remove))$/, new Set(["-n", "-s", "--iterations", "--size"]));
      break;
    case "tee":
      parsed = operands(args, /^(?:-[ai]+|--(?:append|ignore-interrupts))$/, new Set());
      break;
    case "touch":
      parsed = operands(args, /^(?:-[acmh]+|--(?:no-create|no-dereference))$/, new Set(["-t", "-d", "-r", "--date", "--reference"]));
      break;
    case "truncate":
      parsed = operands(args, /^(?:-[co]+|--(?:no-create|io-blocks))$/, new Set(["-s", "--size", "-r", "--reference"]));
      break;
    case "chmod": case "chown": case "chgrp":
      parsed = operands(args, /^(?:-[RcfvhHL]+|--(?:recursive|changes|silent|quiet|verbose|no-dereference))$/, new Set());
      if (parsed) parsed.paths.shift();
      break;
    case "cp": case "mv": case "install": case "ln":
      parsed = operands(args, /^(?:-[rRaAfipnvTsfdbD]+|--(?:recursive|archive|force|no-clobber|no-target-directory|symbolic|directory))$/, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
      if (parsed) {
        const sources = parsed.target ? parsed.paths : parsed.paths.slice(0, -1);
        if (name === "mv" && sources.some((path) => touches(path, true))) return "Deny";
        const directories = name === "install" && args.some((arg) => /^-[^-]*d/.test(arg) || arg === "--directory");
        if (directories) return parsed.paths.some((path) => touches(path, true)) ? "Deny" : undefined;
        const destination = parsed.target ?? parsed.paths.at(-1);
        if (!destination) return "Ask";
        if (touches(destination)) return "Deny";
        // A directory operand may contain a child symlink even when the directory isn't protected.
        if (!sources.length || sources.some((path) => [".", "..", ""].includes(basename(path)))) return "Ask";
        if (sources.some((path) => touches(join(destination, basename(path)), true))) return "Deny";
        if (name === "cp" && args.some((arg) => /^-[^-]*[rRaT]/.test(arg) || ["--recursive", "--archive", "--no-target-directory"].includes(arg))) return "Ask";
        return undefined;
      }
      break;
    case "sed": {
      // Script syntax can itself execute commands or write files. Only identify an explicit -i target.
      const inplace = args[0] === "-i" || args[0]?.startsWith("-i") || args[0]?.startsWith("--in-place");
      if (inplace && args.length >= 3 && !args[1].startsWith("-") && args.slice(2).every((arg) => !arg.startsWith("-")) && args.slice(2).some((path) => touches(path, true))) return "Deny";
      return "Ask";
    }
    case "dd":
      return args.some((arg) => arg.startsWith("of=") && touches(arg.slice(3), true)) ? "Deny" : "Ask";
    default: return "Ask";
  }
  if (!parsed) return "Ask";
  return parsed.paths.some((path) => touches(path, true)) ? "Deny" : undefined;
}

/** Unknown commands also Ask: an interpreter or script can compute a target without naming it. */
export function shellSelfProtection(command: string, touches: Touches): Verdict {
  const tokens = tokenize(command);
  if (!tokens) return "Ask";
  // Stateful shell builtins/wrappers change path or command interpretation for the rest of a list.
  // Don't attribute subsequent relative mutations to the original cwd.
  const segments: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === "operator" && [";", "\n", "&&", "||", "|"].includes(token.value)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  let uncertain = false, uncertainCwd = false;
  for (const segment of segments) {
    const words: string[] = [];
    const currentTouches: Touches = (path, parents) => (!uncertainCwd || isAbsolute(path) || path.startsWith("~/")) && touches(path, parents);
    for (let i = 0; i < segment.length; i++) {
      const token = segment[i];
      if (token.kind === "word") { words.push(token.value); continue; }
      const destination = segment[++i];
      if (!destination || destination.kind !== "word") return "Ask";
      if (token.value !== "<") {
        if (currentTouches(destination.value)) return "Deny";
        if (segments.length > 1) uncertain = true;
      }
    }
    if (!words.length) continue;
    if (/^(?:cd|pushd|popd|eval|exec|source|\.|env|command|builtin|sudo|su|doas|export|unset|alias|unalias)$/.test(words[0])) {
      uncertain = true; uncertainCwd = true; continue;
    }
    // Explicit executable paths aren't assumed to be the standard utility with that basename.
    if (readOnly(words)) continue;
    const verdict = mutation(words, currentTouches);
    if (verdict === "Deny") return verdict;
    // Earlier writes can create aliases or change files used by later commands. No filesystem simulation.
    if (verdict === "Ask" || segments.length > 1) uncertain = true;
  }
  return uncertain ? "Ask" : undefined;
}
