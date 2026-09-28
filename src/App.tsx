export function App() {
  return (
    <main className="min-h-screen bg-[#0B0F17] px-6 py-16 text-slate-200">
      <section className="mx-auto flex max-w-2xl flex-col items-center gap-6 rounded-2xl border border-white/10 bg-slate-900/70 p-10 text-center shadow-2xl">
        <div className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-cyan-300">
          X Automation
        </div>
        <h1 className="text-3xl font-bold text-white">Dashboard disconnected</h1>
        <p className="max-w-xl text-sm leading-6 text-slate-400">
          The dashboard no longer connects to Supabase or any browser-side data source. Scheduled publishing through GitHub Actions, Buffer, and X continues independently.
        </p>
        <div className="w-full rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-left text-sm text-emerald-200">
          Production publishing remains active through the scheduled server-side pipelines.
        </div>
      </section>
    </main>
  );
}
