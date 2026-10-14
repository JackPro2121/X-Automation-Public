import React from 'react';
import { 
  TrendingUp, 
  Users, 
  Sparkles, 
  Zap, 
  ArrowUpRight, 
  Target, 
  FileText,
  Play,
  Cpu,
  Bot,
  Globe,
  CheckCircle2
} from 'lucide-react';
import { Creator, GeneratedPost, BrandConfig, ActiveTab } from '../../types';

interface DashboardTabProps {
  creators: Creator[];
  generatedPosts: GeneratedPost[];
  configs: BrandConfig[];
  setActiveTab: (tab: ActiveTab) => void;
  onRunPipeline: () => void;
}

export const DashboardTab: React.FC<DashboardTabProps> = ({
  creators,
  generatedPosts,
  configs,
  setActiveTab,
  onRunPipeline
}) => {
  const activeConfig = configs.find(c => c.active) || configs[0];

  const totalFollowersAnalyzed = creators.reduce((acc, c) => acc + c.followersCount, 0);
  const approvedPosts = generatedPosts.filter(p => p.status === 'approved' || p.status === 'published');

  return (
    <div className="space-y-6">
      {/* Hero Welcome Banner */}
      <div className="glass-panel p-6 relative overflow-hidden bg-gradient-to-r from-slate-950 via-slate-900/90 to-cyan-950/40 border-cyan-500/20">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-semibold mb-3">
              <Cpu className="w-3.5 h-3.5 fill-cyan-400 animate-pulse" />
              Autonomous AI Engineering & News Engine
            </div>
            <h2 className="text-2xl font-extrabold text-white tracking-tight">
              AI Models, LLMs & Agents <span className="gradient-text-cyan">Auto-Posting Suite</span>
            </h2>
            <p className="text-slate-300 text-sm mt-1.5 max-w-2xl">
              Monitoring <span className="text-white font-semibold">{creators.length} AI Researchers & Creators</span>. 
              Powered by <span className="text-cyan-300 font-semibold">OpenRouter MiniMax-M3 LLM</span> and audited by our <span className="text-emerald-300 font-semibold">Chief Content Officer AI Agent</span> before posting to X.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setActiveTab('studio')}
              className="btn-secondary text-xs"
            >
              <FileText className="w-4 h-4 text-cyan-400" />
              View Content Studio
            </button>
            <button
              onClick={onRunPipeline}
              className="btn-primary text-xs"
            >
              <Play className="w-4 h-4 fill-white" />
              Run AI News Pipeline
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="glass-panel p-4 glass-panel-hover flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">AI Researchers & Creators</span>
            <div className="text-2xl font-bold text-white mt-1">{creators.length} Tracked</div>
            <div className="text-[11px] text-emerald-400 flex items-center gap-1 mt-1">
              <TrendingUp className="w-3 h-3" />
              {totalFollowersAnalyzed.toLocaleString()} Total Reach
            </div>
          </div>
          <div className="p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Users className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-panel p-4 glass-panel-hover flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">AI Agent Approved Posts</span>
            <div className="text-2xl font-bold text-white mt-1">{approvedPosts.length} Ready</div>
            <div className="text-[11px] text-cyan-400 flex items-center gap-1 mt-1">
              <Bot className="w-3 h-3" />
              Audited by CCO AI Agent
            </div>
          </div>
          <div className="p-3 rounded-xl bg-purple-500/10 border border-purple-500/20 text-purple-400">
            <Sparkles className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-panel p-4 glass-panel-hover flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">Primary LLM Model</span>
            <div className="text-lg font-bold text-cyan-300 mt-1 truncate max-w-[150px]">
              MiniMax-M3
            </div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-1">
              <Globe className="w-3 h-3 text-emerald-400" />
              OpenRouter Enabled
            </div>
          </div>
          <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Cpu className="w-6 h-6" />
          </div>
        </div>

        <div className="glass-panel p-4 glass-panel-hover flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">CCO Virality Score</span>
            <div className="text-2xl font-bold text-emerald-400 mt-1">96.2 / 100</div>
            <div className="text-[11px] text-slate-400 flex items-center gap-1 mt-1">
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              Production Grade Standard
            </div>
          </div>
          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <Zap className="w-6 h-6" />
          </div>
        </div>
      </div>

      {/* Main Grid Section: Top Tracked AI Creators & Live Remixed Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Tracked AI Creators & Researchers */}
        <div className="glass-panel p-5 lg:col-span-1 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Users className="w-4 h-4 text-cyan-400" />
              AI Researchers & Radar
            </h3>
            <button
              onClick={() => setActiveTab('competitors')}
              className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
            >
              Radar <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-3">
            {creators.map((c) => (
              <div
                key={c.id}
                className="p-3 rounded-xl bg-slate-900/60 border border-white/5 flex items-center justify-between hover:border-cyan-500/30 transition-all"
              >
                <div className="flex items-center gap-3">
                  <img
                    src={c.avatar}
                    alt={c.name}
                    className="w-9 h-9 rounded-full object-cover border border-white/10"
                  />
                  <div>
                    <div className="text-sm font-semibold text-white flex items-center gap-1.5">
                      {c.name}
                      <span className="text-xs text-slate-400 font-normal">@{c.handle}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {c.followersCount.toLocaleString()} followers • {c.category}
                    </div>
                  </div>
                </div>
                <span className="badge badge-cyan text-[10px]">
                  {c.topViralityScore} Score
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Generated Content Quick Preview */}
        <div className="glass-panel p-5 lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-400" />
              Live AI News Remixed Posts (Vetted by CCO Agent)
            </h3>
            <button
              onClick={() => setActiveTab('studio')}
              className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer"
            >
              Full Studio <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-4">
            {generatedPosts.slice(0, 2).map((gp) => (
              <div
                key={gp.id}
                className="p-4 rounded-xl bg-slate-900/80 border border-white/10 space-y-3 hover:border-cyan-500/30 transition-all"
              >
                <div className="flex items-center justify-between border-b border-white/5 pb-2.5">
                  <div className="flex items-center gap-2">
                    <span className="badge badge-cyan text-xs">
                      {gp.viralityHookTag}
                    </span>
                    <span className="text-xs text-slate-400">
                      Adapted from @{gp.creatorHandle}
                    </span>
                  </div>
                  <span className="badge badge-emerald text-[10px] py-0.5 px-2">
                    Status: {gp.status}
                  </span>
                </div>

                <p className="text-sm text-slate-200 whitespace-pre-line leading-relaxed font-normal">
                  {gp.generatedText}
                </p>

                {gp.infographic && (
                  <div className="px-3 py-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-xs text-cyan-300 flex items-center justify-between">
                    <span>Infographic Attached: <strong>{gp.infographic.title}</strong></span>
                    <span className="text-[11px] text-slate-400">HTML5 Canvas Ready</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
