import { basename } from "node:path";

import { analyzeShell, destinationChild, parseOperands, parseSedOperands, shellPathUsable } from "./shell-analysis.js";

type Verdict = "Deny" | "Ask" | undefined;
type Touches = (path: string, includeParents?: boolean) => boolean;

// This is a classification boundary, not an autoapproval list. All other policies still run.
function readOnly(words: string[]): boolean {
  const [name, ...args] = words;
  if (["cat", "head", "tail", "ls", "stat", "pwd", "wc", "echo", "test", "[", "true", "false", ":"].includes(name)) return true;
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
function mutation(words: string[], touches: Touches): Verdict {
  const [name, ...args] = words;
  let parsed: ReturnType<typeof parseOperands>;
  switch (name) {
    case "rm": case "rmdir": case "unlink": case "shred":
      parsed = parseOperands(args, /^(?:-[rfdiIvPRzun]+|--(?:recursive|force|dir|verbose|zero|remove))$/, new Set(["-n", "-s", "--iterations", "--size"]));
      break;
    case "tee":
      parsed = parseOperands(args, /^(?:-[ai]+|--(?:append|ignore-interrupts))$/, new Set());
      break;
    case "touch":
      parsed = parseOperands(args, /^(?:-[acmh]+|--(?:no-create|no-dereference))$/, new Set(["-t", "-d", "-r", "--date", "--reference"]));
      break;
    case "truncate":
      parsed = parseOperands(args, /^(?:-[co]+|--(?:no-create|io-blocks))$/, new Set(["-s", "--size", "-r", "--reference"]));
      break;
    case "chmod": case "chown": case "chgrp":
      parsed = parseOperands(args, /^(?:-[RcfvhHL]+|--(?:recursive|changes|silent|quiet|verbose|no-dereference))$/, new Set());
      if (parsed) parsed.paths.shift();
      break;
    case "cp": case "mv": case "install": case "ln":
      parsed = parseOperands(args, /^(?:-[rRaAfipnvTsfdbD]+|--(?:recursive|archive|force|no-clobber|no-target-directory|symbolic|directory))$/, new Set(["-t", "--target-directory", "-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"]));
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
        if (sources.some((path) => touches(destinationChild(destination, path), true))) return "Deny";
        if (name === "cp" && args.some((arg) => /^-[^-]*[rRaT]/.test(arg) || ["--recursive", "--archive", "--no-target-directory"].includes(arg))) return "Ask";
        return undefined;
      }
      break;
    case "sed": {
      const sed = parseSedOperands(args);
      if (!sed) return "Ask";
      if (sed.inPlace && sed.paths.some((path) => touches(path, true))) return "Deny";
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
  const analysis = analyzeShell(command);
  let uncertain = !analysis.complete;
  for (let index = 0; index < analysis.segments.length; index++) {
    const { words, redirections } = analysis.segments[index];
    const uncertainCwd = analysis.uncertainCwd[index];
    const currentTouches: Touches = (path, parents) => shellPathUsable(path, uncertainCwd) && touches(path, parents);
    for (const redirection of redirections) {
      if (redirection.operator !== "<") {
        if (currentTouches(redirection.path)) return "Deny";
        if (analysis.segments.length > 1) uncertain = true;
      }
    }
    if (!words.length) continue;
    if (/^(?:cd|pushd|popd|eval|exec|source|\.|env|command|builtin|sudo|su|doas|export|unset|alias|unalias)$/.test(words[0])) { uncertain = true; continue; }
    if (readOnly(words)) continue;
    const verdict = mutation(words, currentTouches);
    if (verdict === "Deny") return verdict;
    if (verdict === "Ask" || analysis.segments.length > 1) uncertain = true;
  }
  return uncertain ? "Ask" : undefined;
}
