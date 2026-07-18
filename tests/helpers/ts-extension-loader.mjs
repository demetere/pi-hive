import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

function isRelativeOrAbsolute(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function hasKnownExtension(specifier) {
  return /\.[cm]?[jt]sx?$/.test(specifier) || /\.json$/.test(specifier) || /\.mjs$/.test(specifier);
}

export async function resolve(specifier, context, nextResolve) {
  if (isRelativeOrAbsolute(specifier) && !hasKnownExtension(specifier)) {
    const parentDir = context.parentURL?.startsWith("file:") ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidatePath = specifier.startsWith("/") ? `${specifier}.ts` : resolvePath(parentDir, `${specifier}.ts`);
    if (existsSync(candidatePath)) {
      return nextResolve(pathToFileURL(candidatePath).href, context);
    }
  }
  return nextResolve(specifier, context);
}
