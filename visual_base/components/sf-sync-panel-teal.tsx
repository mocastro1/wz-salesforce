"use client"

import { useState } from "react"
import {
  User,
  MessageSquare,
  Calendar,
  ExternalLink,
  ChevronDown,
  X,
  Zap,
  Globe,
  Minus,
} from "lucide-react"

interface StatusIndicatorProps {
  status: "online" | "offline"
  label: string
}

function StatusIndicator({ status, label }: StatusIndicatorProps) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          status === "online" ? "bg-emerald-400" : "bg-amber-400"
        }`}
      />
      <span className="text-xs text-teal-100/70">{label}</span>
    </div>
  )
}

interface ActionButtonProps {
  icon: React.ReactNode
  label: string
  variant?: "primary" | "secondary" | "ghost"
  onClick?: () => void
}

function ActionButton({
  icon,
  label,
  variant = "secondary",
  onClick,
}: ActionButtonProps) {
  const baseStyles =
    "flex items-center gap-2.5 w-full px-3 py-2.5 text-sm font-medium rounded-lg transition-all duration-150 ease-out"

  const variants = {
    primary:
      "bg-teal-500 text-white hover:bg-teal-400 active:scale-[0.98] shadow-md shadow-teal-500/20",
    secondary:
      "bg-white text-slate-700 hover:bg-slate-50 active:scale-[0.98] shadow-sm",
    ghost:
      "text-slate-500 hover:text-slate-700 hover:bg-slate-100 active:scale-[0.98]",
  }

  return (
    <button onClick={onClick} className={`${baseStyles} ${variants[variant]}`}>
      <span className="flex h-5 w-5 items-center justify-center">{icon}</span>
      <span>{label}</span>
    </button>
  )
}

export default function SFSyncPanelTeal() {
  const [isOpen, setIsOpen] = useState(true)
  const [isMinimized, setIsMinimized] = useState(false)
  const [activeTab, setActiveTab] = useState<"n8n" | "dom">("dom")

  // Estado minimizado - apenas botao flutuante
  if (isMinimized) {
    return (
      <button
        onClick={() => setIsMinimized(false)}
        className="fixed right-4 top-20 flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500 to-teal-600 text-white shadow-lg shadow-teal-500/25 ring-1 ring-white/20 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-teal-500/30 active:scale-95"
        title="Abrir SF Sync"
      >
        <Zap className="h-5 w-5" />
      </button>
    )
  }

  // Estado fechado - nao renderiza nada
  if (!isOpen) {
    return null
  }

  return (
    <div className="fixed right-4 top-20 w-72 overflow-hidden rounded-xl bg-white shadow-2xl shadow-slate-200/50 ring-1 ring-slate-200/60">
      {/* Header - Gradient Teal */}
      <div className="bg-gradient-to-r from-teal-600 to-teal-500 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/20 backdrop-blur-sm">
              <Zap className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-white">SF Sync</h2>
              <span className="text-[10px] text-teal-100/80">v2.0.0</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Botao minimizar */}
            <button
              onClick={() => setIsMinimized(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-teal-100 transition-colors hover:bg-white/10 hover:text-white"
              title="Minimizar"
            >
              <Minus className="h-4 w-4" />
            </button>
            {/* Botao fechar */}
            <button
              onClick={() => setIsOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-teal-100 transition-colors hover:bg-white/10 hover:text-white"
              title="Fechar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Tab Switcher */}
      <div className="flex bg-gradient-to-r from-teal-600 to-teal-500 px-2 pb-2">
        <div className="flex w-full gap-1 rounded-lg bg-teal-700/30 p-1">
          <button
            onClick={() => setActiveTab("n8n")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all ${
              activeTab === "n8n"
                ? "bg-white text-teal-700 shadow-sm"
                : "text-teal-100 hover:text-white"
            }`}
          >
            <StatusIndicator status="offline" label="" />
            n8n Offline
          </button>
          <button
            onClick={() => setActiveTab("dom")}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all ${
              activeTab === "dom"
                ? "bg-white text-teal-700 shadow-sm"
                : "text-teal-100 hover:text-white"
            }`}
          >
            <Globe className="h-3 w-3" />
            DOM
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-3">
        {/* Contact Card */}
        <div className="mb-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-teal-100 to-teal-50 ring-2 ring-teal-500/10">
              <User className="h-4 w-4 text-teal-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-800">Contato</p>
              <p className="truncate text-xs text-slate-500">+556599685875</p>
            </div>
            <button className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600">
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-2">
          <ActionButton
            icon={<User className="h-4 w-4" />}
            label="Salvar como Lead"
            variant="primary"
          />
          <ActionButton
            icon={<MessageSquare className="h-4 w-4" />}
            label="Registrar Conversa"
            variant="secondary"
          />
          <ActionButton
            icon={<Calendar className="h-4 w-4" />}
            label="Criar Atividade"
            variant="secondary"
          />
          <ActionButton
            icon={<ExternalLink className="h-4 w-4" />}
            label="Abrir no Salesforce"
            variant="ghost"
          />
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-2">
        <p className="text-center text-[10px] text-slate-400">
          Pressione{" "}
          <kbd className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[9px] text-slate-500">
            Esc
          </kbd>{" "}
          para fechar
        </p>
      </div>
    </div>
  )
}
