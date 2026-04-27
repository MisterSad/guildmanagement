import { NextResponse, type NextRequest } from "next/server";

/**
 * Génère une CSP stricte avec un nonce par requête.
 * Le nonce est exposé via le header `x-nonce` pour que le RootLayout puisse
 * l'injecter dans les balises <script> (cf. next/script strategy).
 *
 * Référence : https://nextjs.org/docs/app/guides/content-security-policy
 * Note Next 16 : la convention `middleware` a été renommée `proxy`.
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const isDev = process.env.NODE_ENV === "development";

  const cspDirectives = [
    `default-src 'self'`,
    // 'strict-dynamic' permet aux scripts portant le nonce de charger
    // d'autres scripts. 'unsafe-eval' tolérée en dev pour HMR uniquement.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind v4 inline les styles ; on autorise 'unsafe-inline' pour le CSS
    // uniquement (plus sûr que pour les scripts).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    // Supabase API + Realtime (WebSocket).
    `connect-src 'self' https://*.supabase.co wss://*.supabase.co`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `upgrade-insecure-requests`,
  ];

  const csp = cspDirectives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

export const config = {
  matcher: [
    /*
     * On applique le proxy à toutes les requêtes sauf les assets statiques
     * et le favicon — ceux-ci ne doivent pas porter de CSP par requête.
     */
    {
      source: "/((?!_next/static|_next/image|favicon|.*\\.png$|.*\\.svg$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
