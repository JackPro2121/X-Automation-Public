import React from 'react';
import { 
  LayoutDashboard, 
  Users, 
  Sliders, 
  PlaySquare, 
  Sparkles, 
  MessageSquareQuote, 
  Settings,
  Bot
} from 'lucide-react';
import { ActiveTab } from '../types';

interface SidebarProps {
  activeTab: ActiveTab;
  setActiveTab: (tab: ActiveTab) => void;
  generatedCount: number;
  creatorsCount: number;
  gapsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  setActiveTab,
  generatedCount,
  creatorsCount,
  gapsCount
}) => {
  const navItems = [
    {
      id: 'dashboard' as ActiveTab,
      label: 'AI News Overview',
      icon: LayoutDashboard
    },
    {
      id: 'competitors' as ActiveTab,
      label: 'AI Researchers Radar',
      icon: Users,
      badge: creatorsCount,
      badgeColor: 'badge-cyan'
    },
    {
      id: 'configs' as ActiveTab,
      label: 'Brand DNA Configs',
      icon: Sliders
    },
    {
      id: 'pipeline' as ActiveTab,
      label: 'Automated AI Pipeline',
      icon: PlaySquare
    },
    {
      id: 'studio' as ActiveTab,
      label: 'Content Remix Studio',
      icon: Sparkles,
      badge: generatedCount,
      badgeColor: 'badge-indigo'
    },
    {
      id: 'gaps' as ActiveTab,
      label: 'AI Audience Gap Miner',
      icon: MessageSquareQuote,
      badge: gapsCount,
      badgeColor: 'badge-amber'
    },
    {
      id: 'settings' as ActiveTab,
      label: 'API Keys & Serverless',
      icon: Settings
    }
  ];

  return (
    <aside className="w-64 bg-[#080C14]/90 border-r border-white/10 p-4 flex flex-col justify-between select-none min-h-[calc(100vh-65px)]">
      <div className="space-y-1.5">
        <div className="px-3 py-2 text-[11px] font-bold text-cyan-400/90 uppercase tracking-wider">
          AI Engineering Navigation
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveTab(item.id)}
              className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm font-medium transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-cyan-600/90 via-indigo-600/90 to-violet-600/90 text-white shadow-lg shadow-cyan-500/20'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.label}</span>
              </div>
              {item.badge !== undefined && (
                <span className={`badge text-[10px] py-0 px-2 ${item.badgeColor || 'badge-cyan'}`}>
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* CCO AI Agent Telemetry Footer Box */}
      <div className="glass-panel p-3.5 text-xs space-y-2 mt-6 border-cyan-500/20">
        <div className="flex items-center justify-between text-slate-200 font-semibold">
          <span className="flex items-center gap-1.5 text-cyan-300">
            <Bot className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            CCO AI Agent
          </span>
          <span className="text-emerald-400 font-bold text-[11px]">ACTIVE</span>
        </div>
        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
          <div className="bg-gradient-to-r from-cyan-400 via-indigo-500 to-emerald-400 h-full w-full"></div>
        </div>
        <p className="text-[11px] text-slate-400 leading-tight">
          Auditing virality score, 280-char limits & post quality before X auto-posting.
        </p>
      </div>
    </aside>
  );
};
