import { isIP } from "node:net";

export type NetworkZone = "public" | "protected" | "invalid";
export interface NetworkTargetDecision { readonly target: string; readonly hostname?: string; readonly zone: NetworkZone; readonly reason: string }
export interface NetworkAuthorization { readonly ok: boolean; readonly reason: string; readonly targets: readonly NetworkTargetDecision[] }

const MAX_TARGETS = 32;
const MAX_TARGET_BYTES = 4_096;
const PROTECTED_NAMES = new Set(["localhost", "localhost.localdomain", "metadata.google.internal", "metadata.azure.internal"]);

function protectedIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}
function protectedIp(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized) === 4) return protectedIpv4(normalized);
  if (isIP(normalized) === 6) return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff");
  return false;
}
function hostnameProtected(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return PROTECTED_NAMES.has(lower) || lower.endsWith(".localhost") || lower.endsWith(".local") || protectedIp(lower);
}

export function classifyNetworkTarget(target: string): NetworkTargetDecision {
  if (typeof target !== "string" || !target || Buffer.byteLength(target, "utf8") > MAX_TARGET_BYTES || target.startsWith("unix:"))
    return Object.freeze({ target: String(target), zone: target.startsWith?.("unix:") ? "protected" : "invalid", reason: "invalid or protected transport" });
  try {
    const url = new URL(target.includes("://") ? target : `https://${target}`);
    if (!url.hostname || !["http:", "https:", "ssh:", "git:", "ftp:"].includes(url.protocol)) return Object.freeze({ target, zone: "invalid", reason: "unsupported network target" });
    const zone = hostnameProtected(url.hostname) ? "protected" : "public";
    return Object.freeze({ target, hostname: url.hostname, zone, reason: zone === "public" ? "public external target" : "loopback/private/link-local/metadata target" });
  } catch { return Object.freeze({ target, zone: "invalid", reason: "malformed network target" }); }
}

export function authorizeNetworkTargets(targets: readonly string[], externalNetwork: boolean, resolvedAddresses: Readonly<Record<string, readonly string[]>> = {}): NetworkAuthorization {
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) return Object.freeze({ ok: false, reason: "network target list is missing or exceeds its bound", targets: Object.freeze([]) });
  const decisions = Object.freeze(targets.map(classifyNetworkTarget));
  if (decisions.some((item) => item.zone !== "public")) return Object.freeze({ ok: false, reason: "protected or invalid network zone", targets: decisions });
  for (const decision of decisions) {
    const addresses = decision.hostname ? resolvedAddresses[decision.hostname] : undefined;
    if (addresses && (addresses.length === 0 || addresses.some(protectedIp))) return Object.freeze({ ok: false, reason: "resolved address enters a protected network zone", targets: decisions });
  }
  if (!externalNetwork) return Object.freeze({ ok: false, reason: "external-network capability is not granted", targets: decisions });
  return Object.freeze({ ok: true, reason: "public external network authorized", targets: decisions });
}
