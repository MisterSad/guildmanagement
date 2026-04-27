import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <div className="max-w-xl space-y-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-indigo-400">
          Foundation Galactic Frontier
        </p>
        <h1 className="text-balance text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
          RAD Management
        </h1>
        <p className="text-pretty text-base text-zinc-400 sm:text-lg">
          Guild operations tool — events, members, glory, sanctions and stats.
          A Next.js rewrite is in progress; the legacy app is preserved under{" "}
          <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-sm text-zinc-200">
            legacy/
          </code>{" "}
          and remains live until phase 8 cutover.
        </p>
        <div className="flex flex-col items-center gap-3 pt-4 sm:flex-row sm:justify-center">
          <Link
            href="/login"
            className="inline-flex h-11 items-center justify-center rounded-full bg-indigo-500 px-6 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-400"
          >
            Sign in
          </Link>
        </div>
      </div>
    </main>
  );
}
