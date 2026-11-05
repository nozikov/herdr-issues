// Errors a source can raise. `kind` is one of: auth, network, notFound, other.
export function sourceError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

// Masks the given secrets and anything that looks like a GitHub token.
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("***");
  }
  return out.replace(/gh[pousr]_\w+/g, "***");
}
