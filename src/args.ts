export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required argument "${key}".`);
  }
  return value.trim();
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new Error(`Argument "${key}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Argument "${key}" must be a positive number.`);
  }
  return Math.floor(n);
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  return Boolean(args[key]);
}

export function asArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
