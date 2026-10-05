/**
 * Partner POI API — authenticate with NavMe Key (nm_…).
 *
 * White-label (recommended):
 *   https://api.navme.space/partner-pois?id=<public_id>
 * Origin (Supabase):
 *   https://<project>.supabase.co/functions/v1/partner-pois?id=<public_id>
 *
 * GET    → list (Query scope)
 * POST   → upsert POI (Write scope)
 * DELETE → delete (?poi_id=<uuid>) (Delete scope)
 *
 * Headers:
 *   X-NavMe-Key: nm_…          (preferred)
 *   Authorization: Bearer nm_… (also accepted)
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-navme-key",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      Connection: "keep-alive",
    },
  });
}

function extractApiKey(req: Request): string {
  const headerKey = String(req.headers.get("x-navme-key") || "").trim();
  if (headerKey) return headerKey;
  const auth = String(req.headers.get("authorization") || "").trim();
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (bearer.startsWith("nm_")) return bearer;
  return "";
}

function statusForError(msg: string) {
  if (/invalid api key|missing navme key|unauthorized/i.test(msg)) return 401;
  if (/scope required|permission/i.test(msg)) return 403;
  if (/not found/i.test(msg)) return 404;
  return 400;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const url = new URL(req.url);
  let publicId =
    url.searchParams.get("id") ||
    url.searchParams.get("public_id") ||
    "";
  let poiId =
    url.searchParams.get("poi_id") ||
    url.searchParams.get("poiId") ||
    "";
  let apiKey = extractApiKey(req);
  let poiBody: Record<string, unknown> = {};

  if (req.method === "POST" || req.method === "DELETE") {
    try {
      const body = await req.json();
      if (body && typeof body === "object") {
        const b = body as Record<string, unknown>;
        if (!apiKey && typeof b.api_key === "string") apiKey = b.api_key.trim();
        if (!apiKey && typeof b.key === "string") apiKey = b.key.trim();
        if (!publicId && typeof b.public_id === "string") publicId = b.public_id;
        if (!publicId && typeof b.id === "string" && req.method === "DELETE") publicId = b.id;
        if (!poiId && typeof b.poi_id === "string") poiId = b.poi_id;
        if (!poiId && typeof b.poiId === "string") poiId = b.poiId;
        if (b.poi && typeof b.poi === "object") poiBody = b.poi as Record<string, unknown>;
        else if (typeof b.name === "string" || typeof b.poi_name === "string") poiBody = b;
      }
    } catch {
      // ignore empty / non-JSON body
    }
  }

  apiKey = String(apiKey || "").trim();
  publicId = String(publicId || "").trim().toLowerCase();
  poiId = String(poiId || "").trim();

  if (!apiKey) {
    return json(401, {
      ok: false,
      error: "Missing NavMe Key. Send X-NavMe-Key or Authorization: Bearer nm_…",
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return json(500, { ok: false, error: "Server misconfigured" });
  }

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let rpcName = "partner_list_pois";
  let rpcArgs: Record<string, unknown> = {
    p_api_key: apiKey,
    p_public_id: publicId || null,
  };

  if (req.method === "POST") {
    rpcName = "partner_upsert_poi";
    rpcArgs = {
      p_api_key: apiKey,
      p_public_id: publicId || null,
      p_poi: poiBody,
    };
  } else if (req.method === "DELETE") {
    rpcName = "partner_delete_poi";
    rpcArgs = {
      p_api_key: apiKey,
      p_public_id: publicId || null,
      p_poi_id: poiId || null,
    };
  }

  const { data, error } = await supabase.rpc(rpcName, rpcArgs);

  if (error) {
    const msg = String(error.message || "Request failed");
    return json(statusForError(msg), { ok: false, error: msg });
  }

  return json(req.method === "POST" ? 201 : 200, data ?? { ok: true });
});
