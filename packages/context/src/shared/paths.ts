import { realpath } from "node:fs/promises";
import path from "node:path";

import { ContextPathError } from "../runtime/errors.js";

export async function containedRealPath(root: string, candidate: string): Promise<string> {
  let canonicalRoot: string;
  let canonicalCandidate: string;
  try {
    canonicalRoot = await realpath(root);
    canonicalCandidate = await realpath(path.resolve(root, candidate));
  } catch (cause) {
    throw new ContextPathError({ root, candidate, message: `Cannot resolve existing path within context root`, cause });
  }
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return canonicalCandidate;
  }
  throw new ContextPathError({ root: canonicalRoot, candidate, message: `Path escapes the canonical context root` });
}
