/**
 * Lists Matterport Mattertags for a model (Model API).
 * Secrets: MATTERPORT_TOKEN_ID, MATTERPORT_TOKEN_SECRET (Supabase function secrets).
 *
 * GET ?modelId=fXEtkfPQDR7
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL_API = "https://api.matterport.com/api/models/graph";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, accept",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json(405, { error: "GET only" });
  }

  try {
    const url = new URL(req.url);
    const modelId = String(url.searchParams.get("modelId") || "").trim();
    if (!modelId) return json(400, { error: "modelId is required" });

    const tokenId = String(Deno.env.get("MATTERPORT_TOKEN_ID") || "").trim();
    const tokenSecret = String(Deno.env.get("MATTERPORT_TOKEN_SECRET") || "").trim();
    if (!tokenId || !tokenSecret) {
      return json(500, { error: "Matterport Model API secrets not configured" });
    }

    const auth = "Basic " + btoa(`${tokenId}:${tokenSecret}`);
    const res = await fetch(MODEL_API, {
      method: "POST",
      headers: {
        Authorization: auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query ($id: ID!) {
          model(id: $id) {
            id
            name
            mattertags {
              id
              label
              description
              enabled
              anchorPosition { x y z }
            }
          }
        }`,
        variables: { id: modelId },
      }),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json(502, { error: `Matterport HTTP ${res.status}` });
    }
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      return json(502, { error: String(payload.errors[0]?.message || "Matterport API error") });
    }
    const model = payload?.data?.model;
    if (!model?.id) {
      return json(404, { error: "Matterport model not found for this API token" });
    }

    const mattertags = Array.isArray(model.mattertags) ? model.mattertags : [];
    const tags = mattertags.map((t: Record<string, unknown>) => {
      const pos = (t.anchorPosition || {}) as Record<string, unknown>;
      return {
        id: String(t.id || ""),
        label: String(t.label || "").trim() || "(untitled tag)",
        description: String(t.description || "").trim(),
        enabled: t.enabled !== false,
        pos_x: Number(pos.x),
        pos_y: Number(pos.y),
        pos_z: Number(pos.z),
      };
    }).filter((t: { id: string }) => Boolean(t.id));

    return json(200, {
      modelId: String(model.id),
      modelName: model.name != null ? String(model.name) : null,
      tags,
    });
  } catch (err) {
    return json(500, { error: err instanceof Error ? err.message : String(err) });
  }
});
