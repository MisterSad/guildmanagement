// supabase/functions/_shared/cors.ts

export const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://guildmanagement.vercel.app",
];

// Strict official project Vercel deployments & previews (no open *.vercel.app relay)
const VERCEL_OFFICIAL_REGEX =
  /^https:\/\/(?:[a-zA-Z0-9_-]+\.)?(?:fgf-guild-management|guildmanagement)(?:-[a-zA-Z0-9_-]+)?\.vercel\.app$/i;

const GUILDMGMT_DOMAIN_REGEX = /^https:\/\/[a-z0-9-]+\.guildmgmt\.app$/i;

export function isAllowedOrigin(origin: string): boolean {
  if (!origin || typeof origin !== "string") return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  if (VERCEL_OFFICIAL_REGEX.test(origin)) return true;
  return GUILDMGMT_DOMAIN_REGEX.test(origin);
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
    // Content-Disposition isn't in the default CORS-safelisted response
    // headers, so a cross-origin fetch() can't read it (res.headers.get()
    // silently returns null) unless it's explicitly exposed here -- needed
    // by any function that hands back a downloadable file (e.g.
    // guild-data-export) so the browser can recover the real filename
    // instead of falling back to a generic one. Harmless to expose broadly:
    // it's just a filename hint, never sensitive data.
    "Access-Control-Expose-Headers": "Content-Disposition",
    "Vary": "Origin",
  };
}
