export const REVIEW_IFRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-downloads";

export function safeArtifactHref(href: string): string | undefined {
  const value = href.trim();
  return /^(https?:\/\/|mailto:|#)/i.test(value) ? value : undefined;
}
