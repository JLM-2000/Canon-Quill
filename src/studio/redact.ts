/** Strip credential-shaped text before it is persisted or shown. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sk-ant)-[A-Za-z0-9_-]{12,}\b/g, "[redacted key]")
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted token]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(api[_ -]?key|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
