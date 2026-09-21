import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { shellSelfProtection } from "./shell-self-protection.js";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Policy } from "./config.js";
import type { Candidate, Decision } from "./types.js";
import { fileURLToPath } from "node:url";
import { isOperationTool, operationMatches, operationOutputPaths, operationTarget, parsedUrl, validOperationArgs } from "./operations.js";
import { deterministicDecision } from "./deterministic.js";

/** Resolve existing ancestors without opening the target file, including new files below symlinks. */
export function canonicalPath(path: string, cwd: string): string {
  return resolveCanonicalPath(path, cwd, 0);
}
function resolveCanonicalPath(path: string, cwd: string, links: number): string {
  if (links > 40) throw new Error("Cannot resolve target safely");
  let expanded = path.replace(/^@/, "").replace(/[\u00a0\u202f]/g, " ");
  if (expanded === "~" || expanded.startsWith("~/")) expanded = homedir() + expanded.slice(1);
  const absolute = resolve(cwd, expanded);
  let ancestor = absolute;
  const tail: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...tail); }
    catch (e) {
      if (!["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) throw new Error("Cannot resolve target safely");
      // realpath can't follow a dangling link, but writes can create its protected target.
      let link = false;
      try { link = lstatSync(ancestor).isSymbolicLink(); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Cannot resolve target safely");
      }
      if (link) {
        let destination: string;
        try { destination = readlinkSync(ancestor); }
        catch { throw new Error("Cannot resolve target safely"); }
        return resolveCanonicalPath(resolve(dirname(ancestor), destination, ...tail), cwd, links + 1);
      }
      if (dirname(ancestor) === ancestor) return absolute;
      tail.unshift(basename(ancestor)); ancestor = dirname(ancestor);
    }
  }
}
export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
const secrets = /(?:^|[\/\s'"=])(?:\.env(?:[.\w-]*)?|\.ssh|\.aws|\.kube|id_(?:rsa|ed25519)|credentials(?:\.\w+)?|auth\.json|[^\s/]*\.(?:pem|key|p12|pfx))(?:$|[\/\s'";|&])/i;
const systemPath = /^\/(?:etc|usr|boot|sys|proc|dev|var\/lib)(?:\/|$)/;
/** Conservative lexical detection, never a shell interpreter or a proof of safety. */
export function presetMatch(preset: string, c: Candidate, target: string): boolean {
  const raw = String(c.args.command ?? "");
  const command = raw.replace(/\\\r?\n/g, "").replace(/["'\\]/g, "");
  switch (preset) {
    case "git": return c.tool === "bash" && /\bgit\b/i.test(command) && /\b(?:reset|clean|restore|rebase|checkout|branch|stash|push)\b/i.test(command) && /(?:--hard|--force(?:-with-lease)?|(?:^|\s)-[A-Za-z]*[fD](?:\s|$)|\b(?:reset|restore|rebase)\b|\bstash\s+(?:drop|clear)|checkout\s+\.)/i.test(command);
    case "files": return c.tool === "bash" && /(?:\b(?:rm|rmdir|unlink|shred|truncate|dd|mkfs(?:\.\w+)?)\b|\bfind\b.*(?:-delete|-exec)|(?:^|[^>])>(?!>))/i.test(command);
    case "system": return c.tool === "bash" ? /\b(?:sudo|su|doas|chmod|chown|systemctl|service|mount|umount|reboot|shutdown|apt|apt-get|dnf|yum|pacman|brew)\b/i.test(command) : c.tool !== "read" && systemPath.test(target);
    case "production": return c.tool === "bash" && /\b(?:prod(?:uction)?|deploy|kubectl|terraform|pulumi|ansible-playbook)\b/i.test(command);
    case "secrets": return secrets.test(c.tool === "bash" ? raw : target) || (c.tool !== "bash" && secrets.test(String(c.args.path ?? "").replace(/^@/, ""))) || (c.tool === "bash" && /(?:\b(?:printenv|env)\b|\$(?:\{)?[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)|--(?:password|token|secret)\b)/.test(raw));
    default: return false;
  }
}
export function complexShell(command: string): boolean {
  return /[\n\r;|&<>$`{}()\\'"*?\[\]~]|(?:^|\s)(?:eval|exec|source|env|command|bash|sh|zsh|python\S*|node|ruby|perl|xargs|find|sudo|su|doas)(?:\s|$)|(?:^|\s)\w+=/.test(command);
}
export function describeCandidate(c: Candidate): { target: string; operation: string } {
  if (isOperationTool(c.tool)) return { target: operationTarget(c), operation: validOperationArgs(c.args) ? c.args.operation : "invalid-operation" };
  if (c.tool !== "bash") return { target: canonicalPath(String(c.args.path ?? ""), c.cwd), operation: c.tool };
  const command = String(c.args.command ?? "").trim();
  return { target: canonicalPath(c.cwd, c.cwd), operation: complexShell(command) ? "shell-complex" : command.split(/\s+/).slice(0, command.startsWith("git ") ? 2 : 1).join(" ").slice(0, 100) };
}
export function applicable(p: Policy, c: Candidate, target: string): boolean {
  if (!p.enabled || (p.scope !== "both" && p.scope !== c.actor.kind) || !p.tools.includes(c.tool)) return false;
  if (!operationMatches(p, c)) return false;
  if (p.conditions.preset && !presetMatch(p.conditions.preset, c, target)) return false;
  // A path rule cannot establish what an arbitrary shell command will access.
  if (p.conditions.pathPrefix && (c.tool === "bash" || isOperationTool(c.tool) || !within(canonicalPath(p.conditions.pathPrefix, c.project), target))) return false;
  if (p.conditions.command && (c.tool !== "bash" || c.args.command !== p.conditions.command)) return false;
  return true;
}
export function evaluatePolicies(c: Candidate, policies: Policy[], protectedPaths: string[], judgeEnabled = true): { decision?: Decision; natural: Policy[]; target: string; operation: string } {
  const oversized = isOperationTool(c.tool) ? !validOperationArgs(c.args) : c.tool === "bash" ? typeof c.args.command !== "string" || c.args.command.length > 16000 : typeof c.args.path !== "string" || c.args.path.length > 4096;
  if (oversized) return { target: c.cwd, operation: c.tool, natural: [], decision: { action: "Deny", origin: "policy", reason: "Tool arguments are invalid or exceed the assessment budget (16000 command / 4096 path characters; operations: 64 KB, 12 levels, 32 URLs).", policyIds: ["builtin.argument-budget"], historyIds: [] } };
  const { target, operation } = describeCandidate(c);
  const result = (action: Decision["action"], reason: string, policyIds: string[]): Decision => ({ action, origin: "policy", reason, policyIds, historyIds: [] });
  const command = String(c.args.command ?? "");
  const self = (c.tool === "write" || c.tool === "edit") && protectedPaths.some((p) => within(canonicalPath(p, c.cwd), target));
  const protectedRoots = c.tool === "bash" ? protectedPaths.map((p) => canonicalPath(p, c.cwd)) : [];
  let uncertainShellPath = false;
  const shellVerdict = c.tool === "bash" && protectedRoots.length ? shellSelfProtection(command, (path, includeParents) => {
    // Native @path shorthand and Unicode space normalization aren't shell syntax.
    const expanded = path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
    const parts = expanded.split(sep);
    const symlinkParent = parts.some((part, i) => {
      if (part !== "..") return false;
      const prefix = parts.slice(0, i).join(sep) || ".";
      return canonicalPath(prefix, c.cwd) !== resolve(c.cwd, prefix);
    });
    if (/[\u00a0\u202f]/.test(path) || symlinkParent) {
      // Lexical '..' normalization before symlink traversal can resolve a different target than the OS.
      uncertainShellPath = true; return false;
    }
    const resolved = canonicalPath(expanded.startsWith("@") ? resolve(c.cwd, expanded) : expanded, c.cwd);
    return protectedRoots.some((root) => within(root, resolved) || (includeParents && within(resolved, root)));
  }) : undefined;
  const shell = shellVerdict === "Deny" ? shellVerdict : uncertainShellPath ? "Ask" : shellVerdict;
  const localOperationPaths = operationOutputPaths(c);
  if (c.tool === "web-access" && validOperationArgs(c.args)) {
    for (const value of c.args.urls ?? []) {
      const url = parsedUrl(value)!;
      if (url.protocol === "file:") {
        try { localOperationPaths.push(fileURLToPath(url)); }
        catch { return { target, operation, natural: [], decision: result("Deny", "Invalid local web target.", ["builtin.argument-budget"]) }; }
      }
    }
  }
  const operationSelf = localOperationPaths.some((path) => protectedPaths.some((p) => within(canonicalPath(p, c.cwd), canonicalPath(path, c.cwd))));
  if (self || operationSelf || shell === "Deny") return { target, operation, natural: [], decision: result("Deny", "Guardrails configuration/runtime self-modification is protected. Use the human configuration panel or an external editor.", ["builtin.self-protection"]) };
  const matches = policies.filter((p) => (judgeEnabled || p.kind === "structured") && applicable(p, c, target));
  const structured = matches.filter((p) => p.kind === "structured");
  const natural = matches.filter((p) => p.kind === "natural");
  const builtin = deterministicDecision(c, protectedPaths);
  const unresolvedShell = c.tool === "bash" && shell === "Ask";
  const denies = structured.filter((p) => p.action === "Deny");
  if (denies.length) return { target, operation, natural, decision: result("Deny", denies.map((p) => `${p.name}: Deny${isOperationTool(c.tool) ? " (operation conditions matched locally)" : ` (${JSON.stringify(p.conditions)})`}`).join("; "), denies.map((p) => p.id)) };
  if (builtin?.action === "Deny") return { target, operation, natural, decision: builtin };
  const asks = structured.filter((p) => p.action === "Ask");
  if (asks.length) return { target, operation, natural, decision: result("Ask", asks.map((p) => `${p.name}: Ask${isOperationTool(c.tool) ? " (operation conditions matched locally)" : ` (${JSON.stringify(p.conditions)})`}`).join("; "), asks.map((p) => p.id)) };
  if (builtin?.action === "Ask") return { target, operation, natural, decision: builtin };
  const allows = structured.filter((p) => p.action === "Allow");
  if (!natural.length) {
    // Built-in Allows are narrow proofs, never replacements for applicable restrictions.
    if (builtin?.action === "Allow") return { target, operation, natural, decision: builtin };
    if (allows.length && !unresolvedShell && (!judgeEnabled || c.tool !== "bash" || (!complexShell(command) && allows.some((p) => p.conditions.command === command)))) {
      return { target, operation, natural, decision: result("Allow", `Explicit allow: ${allows.map((p) => p.name).join(", ")}`, allows.map((p) => p.id)) };
    }
  }
  // Unknown shell syntax is unresolved. Judge mode assesses it; rule-only mode uses
  // its documented no-match Allow for both main and worker actors.
  return { target, operation, natural };
}
