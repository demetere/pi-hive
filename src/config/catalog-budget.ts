export class CatalogAggregateLimitError extends Error {
  readonly code = "CATALOG_AGGREGATE_TOO_LARGE";
  constructor() { super("Catalog content exceeds the aggregate safety limit."); }
}

export function isCatalogAggregateLimitError(error: unknown): boolean {
  return error instanceof CatalogAggregateLimitError
    || (typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "CATALOG_AGGREGATE_TOO_LARGE");
}
