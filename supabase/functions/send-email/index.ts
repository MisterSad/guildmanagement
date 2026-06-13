/**
 * send-email: transactional email via Resend (saas_strategy.md §13).
 *
 * Server-to-server utility called by other edge functions / cron flows
 * (welcome, trial reminders, payment-failed). NOT openly callable: requests
 * must carry `x-email-secret: <EMAIL_FN_SECRET>`. verify_jwt = false in
 * config.toml because callers are servers, not signed-in users.
 *
 * Reads its config from env (NEVER hardcode the API key):
 *   RESEND_API_KEY   Resend API key (re_…)  — set as a Supabase function secret
 *   EMAIL_FN_SECRET  shared secret gating this endpoint
 *   EMAIL_FROM       verified sender, e.g. "Guild Management Tool <noreply@yourdomain>"
 *                    (defaults to Resend's test sender until a domain is verified)
 *   EMAIL_REPLY_TO   where replies land (defaults to the Proton support inbox)
 *
 * Body: { "to": "x@y.z" | string[], "subject": "...", "html"?: "...", "text"?: "..." }
 * See docs/email-setup.md.
 */
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FN_SECRET      = Deno.env.get("EMAIL_FN_SECRET") ?? "";
const FROM           = Deno.env.get("EMAIL_FROM") ?? "Guild Management Tool <onboarding@resend.dev>";
const REPLY_TO       = Deno.env.get("EMAIL_REPLY_TO") ?? "fgfguildmanagementtool@proton.me";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  // Gate: only callers holding the shared secret may send mail.
  if (!FN_SECRET || req.headers.get("x-email-secret") !== FN_SECRET) {
    return json({ ok: false, error: "forbidden" }, 403);
  }
  if (!RESEND_API_KEY) return json({ ok: false, error: "not_configured" }, 503);

  let body: { to?: unknown; subject?: unknown; html?: unknown; text?: unknown };
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_request" }, 400); }

  const to = Array.isArray(body.to) ? body.to.map(String) : (body.to ? [String(body.to)] : []);
  const subject = body.subject ? String(body.subject) : "";
  const html = body.html != null ? String(body.html) : undefined;
  const text = body.text != null ? String(body.text) : undefined;
  if (to.length === 0 || !subject || (!html && !text)) {
    return json({ ok: false, error: "missing_fields" }, 400);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to, subject, html, text, reply_to: REPLY_TO }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Resend send failed:", res.status, data);
    return json({ ok: false, error: "send_failed", status: res.status }, 502);
  }
  return json({ ok: true, id: (data as { id?: string }).id ?? null });
});
