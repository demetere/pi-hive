import { OKF_KNOWLEDGE_PROVIDER } from "./okf";
import type { KnowledgeBundleLoadRequest, KnowledgeBundleLoadResult, KnowledgeProvider } from "./types";

export class KnowledgeProviderRegistry {
  private readonly providers = new Map<string, KnowledgeProvider>();

  register(provider: KnowledgeProvider): void {
    if (!provider?.id || !provider.version || typeof provider.load !== "function" || this.providers.has(provider.id)) {
      throw new Error("Knowledge provider registration is invalid or duplicated");
    }
    this.providers.set(provider.id, provider);
  }

  load(request: KnowledgeBundleLoadRequest): KnowledgeBundleLoadResult {
    const provider = this.providers.get(request.declaration.providerId);
    if (!provider) return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([Object.freeze({
        code: "KNOWLEDGE_PROVIDER_UNAVAILABLE",
        severity: "error" as const,
        message: "The declared knowledge provider is unavailable.",
        bundleId: request.declaration.id,
      })]),
    });
    return provider.load(request);
  }

  has(id: string): boolean { return this.providers.has(id); }
}

export function createBuiltInKnowledgeProviderRegistry(): KnowledgeProviderRegistry {
  const registry = new KnowledgeProviderRegistry();
  registry.register(OKF_KNOWLEDGE_PROVIDER);
  return registry;
}
