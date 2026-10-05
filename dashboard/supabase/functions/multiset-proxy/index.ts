/**
 * Proxies MultiSet REST for dashboard 2D/3D (static hosts).
 *
 * Client uses:
 *   POST /functions/v1/multiset-proxy?_path=/v1/m2m/token
 *   GET  /functions/v1/multiset-proxy?_path=/v1/file&key=...
 *   POST /functions/v1/multiset-proxy?_path=/proxy-external-fetch
 *     body: { url: "<signed glb url>" }
 *
 * MultiSet credentials arrive as X-Multiset-Authorization (Basic or Bearer).
 * Authorization/apikey are the Supabase anon key for the gateway.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MULTISET_ORIGIN = "https://api.multiset.ai";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept, x-multiset-authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractPathAndSearch(reqUrl: URL): { path: string; search: string } | null {
  const qp = reqUrl.searchParams.get("_path");
  if (qp && qp.trim()) {
    const path = qp.startsWith("/") ? qp : `/${qp}`;
    const params = new URLSearchParams(reqUrl.searchParams);
    params.delete("_path");
    const rest = params.toString();
    return { path, search: rest ? `?${rest}` : "" };
  }

  const marker = "/multiset-proxy";
  let path = reqUrl.pathname;
  const idx = path.indexOf(marker);
  if (idx >= 0) path = path.slice(idx + marker.length) || "/";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/") return null;
  return { path, search: reqUrl.search };
}

function isAllowedPath(path: string): boolean {
  return path.startsWith("/v1/") || path === "/proxy-external-fetch";
}

function multisetAuthorization(req: Request): string | null {
  const dedicated = req.headers.get("X-Multiset-Authorization")?.trim();
  if (dedicated) return dedicated;
  const auth = req.headers.get("Authorization")?.trim();
  if (!auth) return null;
  if (auth.startsWith("Basic ")) return auth;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const reqUrl = new URL(req.url);
    const extracted = extractPathAndSearch(reqUrl);
    if (!extracted || !isAllowedPath(extracted.path)) {
      return json(400, {
        error: "Path must be ?_path=/v1/... or /functions/v1/multiset-proxy/v1/...",
      });
    }

    if (extracted.path === "/proxy-external-fetch") {
      if (req.method !== "POST") {
        return json(405, { error: "proxy-external-fetch requires POST" });
      }
      const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
      const url = typeof body?.url === "string" ? body.url.trim() : "";
      if (!url || !/^https:\/\//i.test(url)) {
        return json(400, { error: "Missing https url" });
      }
      const upstream = await fetch(url);
      const outHeaders = new Headers(corsHeaders);
      const ct = upstream.headers.get("Content-Type");
      if (ct) outHeaders.set("Content-Type", ct);
      outHeaders.set("Cache-Control", "no-store");
      return new Response(await upstream.arrayBuffer(), {
        status: upstream.status,
        headers: outHeaders,
      });
    }

    const target = `${MULTISET_ORIGIN}${extracted.path}${extracted.search}`;
    const headers = new Headers();
    const auth = multisetAuthorization(req);
    if (auth) headers.set("Authorization", auth);
    headers.set("Accept", req.headers.get("Accept") || "application/json");
    const ct = req.headers.get("Content-Type");
    if (ct) headers.set("Content-Type", ct);

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = await req.arrayBuffer();
    }

    const upstream = await fetch(target, init);
    const outHeaders = new Headers(corsHeaders);
    const upstreamCt = upstream.headers.get("Content-Type");
    if (upstreamCt) outHeaders.set("Content-Type", upstreamCt);
    outHeaders.set("Cache-Control", "no-store");

    return new Response(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json(502, { error: message });
  }
});
