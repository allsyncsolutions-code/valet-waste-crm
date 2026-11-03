/* =====================================================================
 * Valet Waste CRM — issue-report edge function ("Annotate")
 * ---------------------------------------------------------------------
 * Ported from the AllSync issue-report-kit. The poke half of "Annotate":
 * the client already inserted the issue_reports row (RLS-checked, staff
 * only) and uploaded the marked-up screenshot and optional screen
 * recording to the public tickets bucket; this emails the owner (David)
 * with everything — who, which screen, their notes, the screenshot inline,
 * and a link to watch the recording. Row FIRST, email poke second — a
 * failed email never loses the report. The report also lives in the
 * Annotations tab for the whole admin/staff team.
 *
 * Secrets:
 *   SENDGRID_API_KEY   (required — any env var containing "SENDGRID")
 *   HELP_TO_EMAIL      (optional, default david@allsynccrm.com)
 *   HELP_FROM_EMAIL    (optional, default help@allsynccrm.com)
 *   APP_URL            (optional, default the CRM origin passed by the client)
 *
 * Deployed with verify_jwt = false — auth enforced in code (staff role).
 * ===================================================================== */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ ok: false, error: "Not signed in" }, 401);
  const requesterEmail = userData.user.email || "unknown";

  // Staff-only poke, mirroring the RLS on issue_reports.
  const { data: prof } = await admin.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (!["admin", "staff"].includes(prof?.role || "")) return json({ ok: false, error: "Staff only." }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "Bad request" }, 400); }
  const title = String(body.title || "Annotation").slice(0, 200);
  const note = String(body.note || "").slice(0, 4000);
  const screen = body.screen ? String(body.screen) : null;
  const creatorName = body.creator_name ? String(body.creator_name) : requesterEmail;
  const screenshotUrl = body.screenshot_url ? String(body.screenshot_url) : null;
  const videoUrl = body.video_url ? String(body.video_url) : null;

  const base = (body.origin || Deno.env.get("APP_URL") || "https://app.valetwastefla.com").replace(/\/+$/, "");
  const link = `${base}/`;

  const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY")
    || Object.entries(Deno.env.toObject()).find(([k, v]) => v && k.toUpperCase().includes("SENDGRID"))?.[1];
  if (!SENDGRID_API_KEY) return json({ ok: false, error: "No SendGrid key configured" }, 500);

  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f3;font-family:Arial,Helvetica,sans-serif;color:#1a2420">
    <div style="max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#fff;border-radius:16px;border:1px solid #e6ece8;padding:28px">
        <p style="margin:0 0 4px;color:#7c8a82;font-size:13px">Annotation — Valet Waste CRM</p>
        <h1 style="margin:0 0 6px;font-size:22px">${esc(title)}</h1>
        <p style="margin:0 0 16px;font-size:14px;color:#54655a">
          <b>From:</b> ${esc(creatorName)} (${esc(requesterEmail)})${screen ? ` &nbsp;·&nbsp; <b>Screen:</b> ${esc(screen)}` : ""}${body.target_label ? ` &nbsp;·&nbsp; <b>Pinned element:</b> ${esc(String(body.target_label))}` : ""}
        </p>
        ${note ? `<div style="background:#f7f9f7;border-radius:12px;padding:16px;margin:0 0 16px"><p style="margin:0;font-size:15px;white-space:pre-wrap">${esc(note)}</p></div>` : ""}
        ${screenshotUrl ? `<p style="margin:0 0 8px;font-size:13px;color:#54655a">Their marked-up screenshot:</p>
          <a href="${esc(screenshotUrl)}"><img src="${esc(screenshotUrl)}" alt="Marked-up screenshot" style="max-width:100%;border:1px solid #e6ece8;border-radius:12px;margin:0 0 16px" /></a>` : ""}
        ${videoUrl ? `<p style="margin:0 0 16px"><a href="${esc(videoUrl)}" style="display:inline-block;background:#1f7a4d;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;font-size:15px">▶ Watch their screen recording</a></p>` : ""}
        <a href="${esc(link)}" style="display:inline-block;background:#15201b;color:#fff;text-decoration:none;font-weight:700;padding:12px 24px;border-radius:10px;font-size:15px">Open the CRM</a>
        <p style="margin:16px 0 0;font-size:12px;color:#7c8a82">Full thread + history live in the CRM's <b>Annotations</b> tab.</p>
      </div>
    </div></body></html>`;

  const toEmail = Deno.env.get("HELP_TO_EMAIL") || "david@allsynccrm.com";
  const fromEmail = Deno.env.get("HELP_FROM_EMAIL") || "help@allsynccrm.com";
  const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: toEmail }] }],
      from: { email: fromEmail, name: "Valet Waste Annotations" },
      reply_to: requesterEmail !== "unknown" ? { email: requesterEmail } : undefined,
      subject: `Annotation — Valet Waste: ${title}`.slice(0, 250),
      content: [{ type: "text/html", value: html }],
    }),
  });
  return json({ ok: r.ok, emailed: r.ok });
});
