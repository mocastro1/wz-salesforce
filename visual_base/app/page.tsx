import SFSyncPanelTeal from "@/components/sf-sync-panel-teal"

export default function Home() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Background Pattern */}
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] [background-size:20px_20px] opacity-50" />

      {/* Demo Content */}
      <div className="relative flex min-h-screen items-center justify-center p-8">
        <div className="text-center">
          <span className="inline-flex items-center rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700">
            Design Final
          </span>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-slate-900">
            SF Sync Panel
          </h1>
          <p className="mt-2 text-slate-500">
            Versao Teal - Visual enterprise profissional
          </p>
          <div className="mt-6 flex justify-center gap-2">
            <div className="h-6 w-6 rounded-full bg-teal-600 ring-2 ring-teal-600/20" title="Primary" />
            <div className="h-6 w-6 rounded-full bg-teal-500 ring-2 ring-teal-500/20" title="Accent" />
            <div className="h-6 w-6 rounded-full bg-slate-700 ring-2 ring-slate-700/20" title="Text" />
            <div className="h-6 w-6 rounded-full bg-white ring-2 ring-slate-200" title="Background" />
          </div>
        </div>
      </div>

      {/* Panel */}
      <SFSyncPanelTeal />
    </main>
  )
}
