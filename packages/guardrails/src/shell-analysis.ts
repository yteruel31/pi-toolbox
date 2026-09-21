import { isAbsolute } from "node:path";

export type ShellToken = { kind: "word" | "operator"; value: string };
export type ShellSegment = { words: string[]; redirections: Array<{ operator: string; path: string }> };
export type ShellAnalysis = { complete: boolean; segments: ShellSegment[]; uncertainCwd: boolean[] };

/** Parse a deliberately small literal shell grammar. Input is inspected only, never executed. */
export function analyzeShell(command: string): ShellAnalysis {
  const tokens: ShellToken[] = [];
  let word = "", started = false, quote = "", plain = true, complete = true;
  const flush = (ioNumber = false) => {
    if (started && !(ioNumber && plain && /^\d+$/.test(word))) tokens.push({ kind: "word", value: word });
    word = ""; started = false; plain = true;
  };
  scan: for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === "'") {
      if (ch === "~" && (!word || word.endsWith("="))) { complete = false; break; }
      if (ch === "'") quote = ""; else word += ch;
      continue;
    }
    if (ch === "\\") {
      const next = command[++i];
      if (next === undefined || (next === "~" && (!word || word.endsWith("=")))) { complete = false; break; }
      if (next === "\n") continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += "\\";
      word += next; started = true; plain = false; continue;
    }
    if (ch === "$" || ch === "`") { complete = false; break; }
    if (quote === '"') {
      if (ch === "~" && (!word || word.endsWith("="))) { complete = false; break; }
      if (ch === '"') quote = ""; else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; started = true; plain = false; continue; }
    if ("(){}*?[]".includes(ch) || ch === "\r" || ch === "\0") { complete = false; break; }
    if (ch === "~" && !word && (started || (command[i + 1] && !/[\s/;|&<>]/.test(command[i + 1])))) { complete = false; break; }
    if (ch === "~" && word.endsWith("=") && (!plain || !/^[A-Za-z_][A-Za-z_0-9]*=$/.test(word))) { complete = false; break; }
    if (ch === "#" && !started) { while (i + 1 < command.length && command[i + 1] !== "\n") i++; continue; }
    if (";|&<>\n".includes(ch)) {
      flush(ch === "<" || ch === ">");
      let op = ch;
      if (["&&", "||", ">>", ">|", "<>", "&>"].includes(ch + command[i + 1])) op += command[++i];
      if (op === "&" || (ch === "<" && command[i + 1] === "<") || ((ch === ">" || ch === "<") && command[i + 1] === "&")) { complete = false; break scan; }
      tokens.push({ kind: "operator", value: op }); continue;
    }
    if (ch === " " || ch === "\t") { flush(); continue; }
    if (/\s/.test(ch)) { complete = false; break; }
    word += ch; started = true;
  }
  if (quote) complete = false;
  if (complete) flush();

  const segments: ShellSegment[] = [{ words: [], redirections: [] }];
  let validTokens = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "operator" && [";", "\n", "&&", "||", "|"].includes(token.value)) { segments.push({ words: [], redirections: [] }); continue; }
    if (token.kind === "operator") {
      const target = tokens[++i];
      if (!target || target.kind !== "word") { validTokens = false; break; }
      segments.at(-1)!.redirections.push({ operator: token.value, path: target.value });
    } else segments.at(-1)!.words.push(token.value);
  }
  if (!validTokens) complete = false;
  if (!complete) {
    // Only boundaries prove that a prefix segment was complete. Never classify
    // words or redirections from the segment interrupted by unsupported syntax.
    const boundaryCount = tokens.filter((token) => token.kind === "operator" && [";", "\n", "&&", "||", "|"].includes(token.value)).length;
    segments.splice(boundaryCount);
  }
  while (segments.length && !segments.at(-1)!.words.length && !segments.at(-1)!.redirections.length) segments.pop();

  let changed = false;
  const uncertainCwd = segments.map((segment) => {
    const result = changed;
    if (/^(?:cd|pushd|popd|eval|exec|source|\.|env|command|builtin|sudo|su|doas|export|unset|alias|unalias)$/.test(segment.words[0] ?? "")) changed = true;
    return result;
  });
  return { complete, segments, uncertainCwd };
}

export function shellPathUsable(path: string, uncertainCwd: boolean): boolean {
  return !uncertainCwd || isAbsolute(path) || path.startsWith("~/");
}

/** Parse only known option layouts; unknown options cannot hide paths or scripts. */
export function destinationChild(destination: string, source: string): string {
  const child = source.split("/").at(-1);
  return child ? `${destination.replace(/\/$/, "")}/${child}` : destination;
}

/** Extract targets from supported sed layouts without treating the script as a path. */
export function parseSedOperands(args: string[]): { paths: string[]; inPlace: boolean } | undefined {
  const paths: string[] = [];
  let inPlace = false, explicitScript = false, positionalScript = false, end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === "--") { end = true; continue; }
    if (!end && (arg === "-e" || arg === "--expression" || arg === "-f" || arg === "--file")) {
      if (!args[++i]) return undefined;
      explicitScript = true;
      continue;
    }
    if (!end && /^(?:-e.+|-f.+|--(?:expression|file)=.+)$/.test(arg)) { explicitScript = true; continue; }
    if (!end && (arg === "-i" || /^-i.+/.test(arg) || arg === "--in-place" || arg.startsWith("--in-place="))) { inPlace = true; continue; }
    if (!end && arg.startsWith("-")) return undefined;
    if (!explicitScript && !positionalScript) { positionalScript = true; continue; }
    paths.push(arg);
  }
  if (!explicitScript && !positionalScript) return undefined;
  return { paths, inPlace };
}

export function parseOperands(args: string[], flags: RegExp, values: Set<string>): { paths: string[]; target?: string; optionPaths: string[] } | undefined {
  const paths: string[] = [], optionPaths: string[] = [];
  let target: string | undefined, end = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!end && arg === "--") { end = true; continue; }
    if (!end && arg.startsWith("-")) {
      const equal = arg.indexOf("="), option = equal < 0 ? arg : arg.slice(0, equal);
      if (values.has(option)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value) return undefined;
        if (option === "-t" || option === "--target-directory") target = value;
        else optionPaths.push(value);
      } else if (!flags.test(arg)) return undefined;
    } else paths.push(arg);
  }
  return { paths, target, optionPaths };
}
