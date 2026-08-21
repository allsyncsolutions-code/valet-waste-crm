// randy-voice — Trashy Randy's ears and mouth. ElevenLabs speech-to-text +
// text-to-speech behind a staff gate, so drivers can TALK to Randy hands-free.
// The brain is unchanged: the app transcribes here, sends the text to the
// dispatch-ai function as usual, then sends Randy's reply back here to speak.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   ELEVENLABS_API_KEY  — from elevenlabs.io → Profile → API keys
//   ELEVENLABS_VOICE_ID — the voice picked from the ElevenLabs Voice Library
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"
import { decodeBase64, encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const XI_KEY = Deno.env.get("ELEVENLABS_API_KEY") || ""
const XI_VOICE = Deno.env.get("ELEVENLABS_VOICE_ID") || ""

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

// Make Randy's chat text speakable: drop markdown/list syntax and cap length
// (long answers read fine on screen but drag on out loud — and cost credits).
function speakable(text: string) {
  let t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*_#>`~]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link I sent")
    .replace(/\s+/g, " ")
    .trim()
  if (t.length > 1200) t = t.slice(0, 1180).replace(/\s+\S*$/, "") + "… check the chat for the rest."
  return t
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS })
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } })

  try {
    // Staff gate — same pattern as dispatch-ai.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "")
    const isSystemCaller = !!token && token === SERVICE_KEY
    if (!isSystemCaller) {
      const ures = token
        ? await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` } })
        : null
      if (!ures || !ures.ok) return json({ error: "Please sign in to talk to Trashy Randy." }, 401)
      const callerId = (await ures.json())?.id
      const pres = callerId
        ? await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(callerId)}&select=role`, {
            headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
          })
        : null
      const prof = pres && pres.ok ? await pres.json() : []
      if (!["admin", "staff"].includes(prof?.[0]?.role)) {
        return json({ error: "Voice Randy is only available to staff accounts." }, 403)
      }
    }

    if (!XI_KEY) {
      return json({ error: "Voice isn't connected yet — add the ELEVENLABS_API_KEY secret in Supabase (Edge Functions → Secrets)." })
    }

    const body = await req.json()
    const action = body?.action

    // ---- speech → text -----------------------------------------------------
    if (action === "transcribe") {
      const b64 = body?.audio_b64
      if (!b64) return json({ error: "No audio received." }, 400)
      const bytes = decodeBase64(String(b64))
      if (bytes.length < 1200) return json({ text: "" }) // too short to be speech
      const form = new FormData()
      form.append("file", new Blob([bytes], { type: body?.mime || "audio/m4a" }), "speech.m4a")
      form.append("model_id", "scribe_v1")
      const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": XI_KEY },
        body: form,
      })
      if (!r.ok) return json({ error: `Transcription failed: ${r.status} ${(await r.text()).slice(0, 300)}` })
      const d = await r.json()
      return json({ text: (d?.text || "").trim() })
    }

    // ---- text → speech -----------------------------------------------------
    if (action === "speak") {
      if (!XI_VOICE) {
        return json({ error: "No voice picked yet — add the ELEVENLABS_VOICE_ID secret (copy a Voice ID from the ElevenLabs Voice Library)." })
      }
      const text = speakable(body?.text)
      if (!text) return json({ error: "Nothing to say." }, 400)
      const r = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(XI_VOICE)}?output_format=mp3_44100_64`,
        {
          method: "POST",
          headers: { "xi-api-key": XI_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            model_id: "eleven_flash_v2_5", // low latency + cheapest per character
            voice_settings: { stability: 0.45, similarity_boost: 0.8 },
          }),
        },
      )
      if (!r.ok) return json({ error: `Speech failed: ${r.status} ${(await r.text()).slice(0, 300)}` })
      const audio = new Uint8Array(await r.arrayBuffer())
      return json({ audio_b64: encodeBase64(audio), mime: "audio/mpeg" })
    }

    return json({ error: "Unknown action — use 'transcribe' or 'speak'." }, 400)
  } catch (e) {
    return json({ error: (e as Error)?.message || String(e) }, 500)
  }
})
