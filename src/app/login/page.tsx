import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * Placeholder de la page de connexion.
 * L'intégration Supabase Auth (email magic link) est livrée en phase 1.
 */
export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-24">
      <div className="w-full max-w-sm space-y-6 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-8 backdrop-blur">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-zinc-400">
            Authentication will be wired up in phase 1 (Supabase Auth, magic
            link).
          </p>
        </div>
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-center text-xs text-amber-200">
          Placeholder page — not functional yet.
        </p>
      </div>
    </main>
  );
}
