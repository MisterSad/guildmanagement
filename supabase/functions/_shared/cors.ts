// supabase/functions/_shared/cors.ts

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://fgf-guild-management.vercel.app",
];

export function getCorsHeaders(req?: Request): Record<string, string> {
  let origin = "*";
  if (req) {
    const reqOrigin = req.headers.get("origin") || req.headers.get("Origin");
    if (reqOrigin) {
      const isAllowed =
        ALLOWED_ORIGINS.includes(reqOrigin) ||
        reqOrigin.endsWith(".vercel.app") ||
        reqOrigin.includes("guildmgmt.app");
      if (isAllowed) {
        origin = reqOrigin;
      }
    }
  }

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-correlation-id, x-cron-secret",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  };
}
