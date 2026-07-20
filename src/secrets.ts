const SECRET_PATTERNS = [
  "-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----",
  "(?:api[_-]?key|access[_-]?token|secret|password|passwd|pwd)\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
  "(?:AKIA|ASIA)[A-Z0-9]{16}",
  "gh[pousr]_[A-Za-z0-9_]{36,}",
  "sk-[A-Za-z0-9]{20,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
].map((source) => new RegExp(source, "i"));

export function findSecretReason(parts: Array<string | null | undefined>): string | null {
  const text = parts.filter(Boolean).join("\n");
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

export function assertNoObviousSecrets(parts: Array<string | null | undefined>): void {
  const reason = findSecretReason(parts);
  if (reason) throw new Error(`Refused write: content looks like it may contain secrets (${reason}).`);
}
