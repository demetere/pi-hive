const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === PI_PACKAGE || specifier.startsWith(`${PI_PACKAGE}/`) || specifier === "undici" || specifier.startsWith("undici/")) {
    throw new Error(`forbidden runtime dependency loaded: ${specifier}`);
  }
  return nextResolve(specifier, context);
}
