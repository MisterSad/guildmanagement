import { NextResponse, type NextRequest } from "next/server";

/**
 * Génère une CSP stricte avec un nonce par requête.
 * Le nonce est exposé via le header `x-nonce` pour que le RootLayout puisse
 * l'injecter dans les balises <script> (cf. next/script strategy).
 *
 * Référence : https://nextjs.org/docs/app/guides/content-security-policy
 * Note Next 16 : la convention `middleware` a été renommée `proxy`.
 *
 * Important : ce fichier s'exécute dans le runtime Edge — on évite donc les
 * APIs Node.js (Buffer, fs, …). On utilise `crypto.getRandomValues` + `btoa`,
 * tous deux disponibles nativement.
 */
export function proxy(request: NextRequest) {
  // Nonce CSP : 16 octets aléatoires encodés en base64 (~22 chars).
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const nonce = btoa(binary);

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

  // On propage le nonce et la CSP côté request → le RootLayout pourra lire
  // le nonce via headers().
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);

  return response;
}

/**
 * Matcher : on cible toutes les routes sauf les assets statiques.
 * Format string (officiel Next 16) plutôt qu'objet, plus prévisible.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:png|jpg|jpeg|svg|ico|webp|woff|woff2)$).*)",
  ],
};
