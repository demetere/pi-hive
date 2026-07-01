export function isSameOriginRequest(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;
  return true;
}

export const isSameOriginWrite = isSameOriginRequest;
