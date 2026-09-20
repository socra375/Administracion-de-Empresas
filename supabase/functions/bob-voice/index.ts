// bob-voice: puente seguro entre el navegador y ElevenLabs para la voz de "Bob".
//
// A diferencia de bob-proxy (que usa una clave de Gemini del proyecto), aquí la clave es de
// CADA NEGOCIO: el dueño la pega desde Configuración → Asistente y se guarda en la tabla
// business_secrets, que ninguna sesión de cliente puede leer (RLS sin políticas + sin GRANT).
// Solo esta función, con service_role, la lee para llamar a ElevenLabs — la clave nunca vuelve
// al navegador ni aparece en ninguna respuesta.
//
// Acciones:
//   list_voices -> las voces disponibles en la cuenta de ElevenLabs de ese negocio
//   speak       -> convierte un texto corto en audio mp3 con la voz elegida
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGIN = "https://socra375.github.io";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

// Modelo de menor latencia de ElevenLabs con soporte multilingüe (incluye español): la voz de
// Bob tiene que sentirse inmediata, no una locución de estudio.
const TTS_MODEL = "eleven_flash_v2_5";
const MAX_TTS_CHARS = 500; // tope duro: el usuario paga por carácter en su propia cuenta

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    if (!jwt) return jsonResponse({ error: "unauthorized" }, 401);

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(jwt);
    if (userErr || !userData?.user) return jsonResponse({ error: "unauthorized" }, 401);

    // El negocio se deriva del JWT, nunca de lo que mande el cliente: así un usuario no puede
    // pedir que se use la clave (ni gastar los créditos) de otro negocio.
    const userId = userData.user.id;
    const { data: member } = await supabaseAdmin
      .from("business_members")
      .select("business_id")
      .eq("user_id", userId)
      .maybeSingle();
    const businessId = member?.business_id || userId; // sin fila = negocio individual (id = uid)

    const { data: secret } = await supabaseAdmin
      .from("business_secrets")
      .select("elevenlabs_api_key")
      .eq("business_id", businessId)
      .maybeSingle();
    const apiKey = secret?.elevenlabs_api_key;

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || "");

    if (!apiKey) return jsonResponse({ configured: false, voices: [] });

    if (action === "list_voices") {
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey },
      });
      if (!res.ok) {
        console.error("ElevenLabs list_voices", res.status, await res.text());
        return jsonResponse({ configured: true, voices: [], error: "No pude leer las voces de tu cuenta de ElevenLabs. Revisa que la clave sea válida." });
      }
      const data = await res.json();
      const voices = (data?.voices || []).map((v: { voice_id: string; name: string; labels?: Record<string, string> }) => ({
        voice_id: v.voice_id,
        name: v.name,
        labels: v.labels || {},
      }));
      return jsonResponse({ configured: true, voices });
    }

    if (action === "speak") {
      const text = String(body?.text || "").slice(0, MAX_TTS_CHARS).trim();
      const voiceId = String(body?.voice_id || "").trim();
      if (!text || !voiceId) return jsonResponse({ error: "faltan text o voice_id" }, 400);

      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: TTS_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        },
      );

      if (!res.ok) {
        console.error("ElevenLabs speak", res.status, await res.text());
        // El cliente cae automáticamente a la voz del navegador cuando esto falla.
        return jsonResponse({ error: "tts_failed" }, 502);
      }

      const audio = await res.arrayBuffer();
      return new Response(audio, {
        headers: { ...CORS_HEADERS, "Content-Type": "audio/mpeg" },
      });
    }

    return jsonResponse({ error: "acción desconocida" }, 400);
  } catch (e) {
    console.error("bob-voice error:", e);
    return jsonResponse({ error: "error inesperado" }, 500);
  }
});
