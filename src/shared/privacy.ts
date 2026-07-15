const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|private[-_]?key|client[-_]?secret)$/i;

export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g, REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, `$1 ${REDACTED}`)
    .replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passwd|secret|client[-_]?secret)\s*[=:]\s*)(["']?)[^\s,"';&]+\2/gi, `$1${REDACTED}`)
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, `$1${REDACTED}$2`);
}

export function redactSensitive<T>(value: T, enabled = true, seen = new WeakSet<object>()): T {
  if (!enabled) return value;
  if (typeof value === "string") return redactSensitiveText(value) as T;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value as object)) return REDACTED as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry, true, seen)) as T;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSensitive(entry, true, seen);
  }
  return output as T;
}
