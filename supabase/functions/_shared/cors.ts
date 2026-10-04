// supabase/functions/_shared/cors.ts

/**
 * The audit proposed removing the localhost entries from production. They stay,
 * deliberately: this project's documented development loop runs `npm run build`
 * and serves `dist/` on 5173 while calling the DEPLOYED Edge Functions, so
 * removing them breaks local development outright rather than in some future
 * refactor.
 *
 * The exposure is bounded and worth stating: sessions are bearer tokens in
 * `localStorage`, not cookies, so a page on another origin cannot read a
 * victim's token through CORS — it can only make unauthenticated calls, which
 * every endpoint already refuses. The genuine hole here was the Vercel regex
 * below, and that one is fixed.
 */
export const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3000",
  "https://guildmanagement.vercel.app",
];

/**
 * Official project deployments and their previews.
 *
 * FINDING M13, now closed: the previous pattern ended in
 * `(?:-[a-zA-Z0-9_-]+)?\.vercel\.app`, which made `guildmanagement-evil`
 * match. Anyone could create a Vercel project with that name and become a
 * trusted origin for every Edge Function.
 *
 * Vercel deployment URLs are `<project>-<hash>-<scope>`, branch previews are
 * `<project>-git-<branch>-<scope>`, and the project alias is
 * `<project>-<scope>` — every one of them ends in the owning scope.
 * so the suffix is real and cannot simply be dropped — it is now bounded to the
 * scope that actually owns these deployments instead of accepting any word.
 * The scope is not a guess: `LICENSE` cites
 * `guildmanagement-mistersads-projects.vercel.app`, which is also why the hash
 * segment has to be optional.
 */
const VERCEL_TEAM_SCOPE = "mistersads-projects";
const VERCEL_OFFICIAL_REGEX = new RegExp(
  "^https://(?:fgf-guild-management|guildmanagement)" +
    "(?:(?:-git-[a-z0-9][a-z0-9-]*|-[a-z0-9]{6,})?-" +
    VERCEL_TEAM_SCOPE +
    ")?" +
    "\\.vercel\\.app$",
  "i"
);

/**
 * Every origin trusted here must be one this project controls, because the
 * list does two jobs: CORS, and the set of places `auth-discord` will send a
 * one-time sign-in ticket back to. An origin on a domain nobody owns is a
 * ticket drop box for whoever registers it next.
 *
 * `*.guildmgmt.app` used to be trusted for "a future custom domain". That
 * domain was never registered (NXDOMAIN, 2026-10-03), so anyone could have
 * bought it and harvested Discord sign-ins with a crafted login link. It
 * survives only as the namespace of the synthetic shadow-user e-mails
 * (`shadow-session.ts`), which no browser ever loads.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (!origin || typeof origin !== "string") return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return VERCEL_OFFICIAL_REGEX.test(origin);
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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-correlation-id, x-cron-secret",
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
