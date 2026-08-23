// supabase/functions/_shared/cors.ts

export const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://fgf-guild-management.vercel.app",
];

// OWNER DECISION: any https://*.vercel.app origin is accepted (Vercel preview deployments).
// Residual risk accepted: any Vercel project's page may call these APIs from a browser.
// Mitigation: every sensitive function requires a valid JWT; CORS only gates browser-side
// response readability, not the auth itself.
export function isAllowedOrigin(origin: string): boolean {
  if (!origin || typeof origin !== "string") return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (/^https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app$/i.test(origin)) return true;
  return /^https:\/\/[a-z0-9-]+\.guildmgmt\.app$/i.test(origin);
}

export function getCorsHeaders(req?: Request): Record<string, string> {
  let origin = ALLOWED_ORIGINS[0];
  if (req) {
    const reqOrigin = req.headers.get("origin") || req.headers.get("Origin");
    if (reqOrigin && isAllowedOrigin(reqOrigin)) {
      origin = reqOrigin;
    }
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id, x-cron-secret",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Vary": "Origin",
  };
}
