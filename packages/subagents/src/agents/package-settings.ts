import type {
  EffectivePackageSetting,
  PackageSettingObject,
  PackageSettingsByScope,
} from "./types.js";

/**
 * Normalize Pi package settings into one deterministic effective sequence.
 * Later declarations replace earlier declarations with the same source and
 * move to their later position. Trusted project settings therefore override
 * user settings without leaving two copies in the package scan order.
 */
export function normalizePackageSettings(
  settings: PackageSettingsByScope,
): EffectivePackageSetting[] {
  const ordered = new Map<string, EffectivePackageSetting>();
  let order = 0;

  const addScope = (values: readonly unknown[], scope: "user" | "project") => {
    for (const value of values) {
      const normalized = normalizeOne(value);
      if (!normalized) continue;
      const effective: EffectivePackageSetting = {
        ...normalized,
        scope,
        order: order++,
      };
      ordered.delete(effective.source);
      ordered.set(effective.source, effective);
    }
  };

  addScope(settings.user ?? [], "user");
  if (settings.projectTrusted) addScope(settings.project ?? [], "project");
  return [...ordered.values()];
}

function normalizeOne(value: unknown): PackageSettingObject | undefined {
  if (typeof value === "string") {
    const source = value.trim();
    return source ? { source } : undefined;
  }
  if (!isRecord(value) || typeof value.source !== "string") return undefined;
  const source = value.source.trim();
  if (!source) return undefined;
  if (value.autoload !== undefined && typeof value.autoload !== "boolean") {
    return undefined;
  }
  return { ...value, source } as PackageSettingObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
