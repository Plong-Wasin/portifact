export function errorStatusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["statusCode", "status"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

export function errorCodeOf(error: unknown, fallback = "INTERNAL_ERROR"): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && record.code.trim()) return record.code.trim();
    if (record.body && typeof record.body === "object") {
      const bodyCode = (record.body as Record<string, unknown>).code;
      if (typeof bodyCode === "string" && bodyCode.trim()) return bodyCode.trim();
    }
  }
  if (error instanceof Error && error.name !== "Error") return error.name;
  return fallback;
}
