import React from 'react';
import { Play, Key, Cpu, RefreshCw, Sparkles, ShieldCheck } from 'lucide-react';
import { APIKeys } from '../types';

interface NavbarProps {
  apiKeys: APIKeys;
  isPipelineRunning: boolean;
  onRunPipelineClick: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  apiKeys,
  isPipelineRunning,
  onRunPipelineClick
}) => {
  // OpenRouter runs server-side via cron — always show as active
  const hasLLM = true;
  const hasApify = Boolean(apiKeys.apifyKey);

  return (
    <header className="w-full bg-[#080C14]/90 backdrop-blur-xl border-b border-white/10 px-6 py-3.5 flex items-center justify-between sticky top-0 z-50">
      {/* Brand Identity */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 via-indigo-600 to-violet-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
          <Cpu className="w-5 h-5 text-white animate-pulse" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-white tracking-tight">
              AI Engineering<span className="gradient-text ml-1.5">News Hub</span>
            </h1>
            <span className="badge badge-cyan text-[10px] py-0.5 px-2">v3.0 Production Engine</span>
          </div>
          <p className="text-xs text-slate-400">
            Autonomous X Auto-Poster & AI CCO Intelligence Engine
          </p>
        </div>
      </div>

      {/* Quick Actions & Status Telemetry */}
      <div className="flex items-center gap-3">
        {/* OpenRouter LLM Indicator */}
        <div className="hidden sm:flex items-center gap-2 bg-slate-900/90 border border-cyan-500/30 px-3 py-1.5 rounded-lg text-xs">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-slate-300 font-medium">OpenRouter MiniMax-M3</span>
          <span className={`w-2 h-2 rounded-full ${hasLLM ? 'bg-emerald-400 animate-pulse' : 'bg-cyan-400'}`}></span>
        </div>

        {/* X API OAuth Indicator */}
        <div className="flex items-center gap-2 bg-slate-900/90 border border-white/10 px-3 py-1.5 rounded-lg text-xs">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span className="text-slate-300 font-medium">X API v2 OAuth 1.0a</span>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        </div>

        {/* Run AI Pipeline Button */}
        <button
          onClick={onRunPipelineClick}
          disabled={isPipelineRunning}
          className={`btn-primary text-xs ${isPipelineRunning ? 'opacity-75 cursor-not-allowed' : ''}`}
        >
          {isPipelineRunning ? (
            <>
              <RefreshCw className="w-4 h-4 animate-spin text-white" />
              Scraping & AI Generating...
            </>
          ) : (
            <>
              <Play className="w-4 h-4 fill-white" />
              Run AI News Pipeline
            </>
          )}
        </button>
      </div>
    </header>
  );
};
