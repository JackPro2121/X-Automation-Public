import React, { useState, useRef, useEffect } from 'react';
import { PlaySquare, Play, Sliders, CheckCircle2, RefreshCw, Zap, ShieldCheck } from 'lucide-react';
import { PipelineSettings, BrandConfig, Creator } from '../../types';

interface PipelineTabProps {
  settings: PipelineSettings;
  configs: BrandConfig[];
  creators: Creator[];
  onSaveSettings: (settings: PipelineSettings) => void;
  onRunPipeline: () => void;
  isPipelineRunning: boolean;
}

export const PipelineTab: React.FC<PipelineTabProps> = ({
  settings,
  configs,
  creators,
  onSaveSettings,
  onRunPipeline,
  isPipelineRunning
}) => {
  const [formData, setFormData] = useState<PipelineSettings>({ ...settings });
  const [stepIndex, setStepIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const steps = [
    'Connecting to X Scraper & fetching creators list...',
    'Scraping latest 20 tweets per competitor profile...',
    'Filtering top 3 viral posts per creator (Virality Score > 85)...',
    'Deconstructing hooks & psychological viral frameworks...',
    'Applying Brand Strategy Config & tailoring to ICP...',
    'Generating Visual Infographic diagrams & custom CTAs...',
    'Pipeline Execution Complete! Remixed content pushed to Studio Feed.'
  ];

  // Cleanup interval on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const handleRun = () => {
    onSaveSettings(formData);
    setStepIndex(1);
    
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    
    // Simulate step progression
    intervalRef.current = setInterval(() => {
      setStepIndex((prev) => {
        if (prev >= steps.length - 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return steps.length - 1;
        }
        return prev + 1;
      });
    }, 1200);

    onRunPipeline();
  };

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <PlaySquare className="w-5 h-5 text-emerald-400" />
            Viral Scraper & Remix Pipeline Engine
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            Scrapes the top performing 1% viral content from your competitor radar, extracts their hook formulas, and regenerates unique brand-tailored posts with visual infographics.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Settings Panel */}
        <div className="glass-panel p-6 lg:col-span-2 space-y-5">
          <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
            <Sliders className="w-4 h-4 text-indigo-400" />
            Pipeline Parameters & Controls
          </h3>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Select Brand Strategy Configuration
              </label>
              <select
                value={formData.configId}
                onChange={(e) => setFormData({ ...formData, configId: e.target.value })}
                className="glass-input w-full"
              >
                {configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.category})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Posts Scraped Per Creator
                </label>
                <input
                  type="number"
                  min={5}
                  max={50}
                  value={formData.postsPerCreator}
                  onChange={(e) => setFormData({ ...formData, postsPerCreator: parseInt(e.target.value) || 20 })}
                  className="glass-input w-full"
                />
                <span className="text-[11px] text-slate-500 mt-1 block">
                  Picks top 3 viral winners out of these posts
                </span>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  Time Window Lookback
                </label>
                <select
                  value={formData.lookbackDays}
                  onChange={(e) => setFormData({ ...formData, lookbackDays: parseInt(e.target.value) || 30 })}
                  className="glass-input w-full"
                >
                  <option value={7}>Past 7 Days (Fresh Trends)</option>
                  <option value={14}>Past 14 Days</option>
                  <option value={30}>Past 30 Days (Recommended)</option>
                  <option value={90}>Past 90 Days</option>
                </select>
              </div>
            </div>

            <div className="pt-2 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={formData.autoGenerateInfographics}
                  onChange={(e) => setFormData({ ...formData, autoGenerateInfographics: e.target.checked })}
                  className="w-4 h-4 rounded accent-indigo-500"
                />
                <span className="text-xs text-slate-200 font-medium">
                  Auto-generate Visual Infographic Diagrams for eligible posts
                </span>
              </label>

              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={formData.includeCTAs}
                  onChange={(e) => setFormData({ ...formData, includeCTAs: e.target.checked })}
                  className="w-4 h-4 rounded accent-indigo-500"
                />
                <span className="text-xs text-slate-200 font-medium">
                  Append custom conversion Call-to-Actions (CTAs) from Brand Config
                </span>
              </label>
            </div>
          </div>

          <div className="pt-4 border-t border-white/10 flex items-center justify-between">
            <div className="text-xs text-slate-400">
              Scraping <strong>{creators.length} creators</strong> • Est. execution time: ~15 seconds
            </div>
            <button
              onClick={handleRun}
              disabled={isPipelineRunning}
              className={`btn-emerald text-sm ${isPipelineRunning ? 'opacity-70 cursor-not-allowed' : ''}`}
            >
              {isPipelineRunning ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Running Pipeline Engine...
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 fill-white" />
                  Execute Pipeline Now
                </>
              )}
            </button>
          </div>
        </div>

        {/* Execution Log & Monitor Console */}
        <div className="glass-panel p-6 lg:col-span-1 space-y-4 flex flex-col justify-between">
          <div>
            <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
              <Zap className="w-4 h-4 text-amber-400" />
              Live Pipeline Execution Console
            </h3>

            <div className="space-y-3 mt-4">
              {steps.map((step, idx) => {
                const isDone = idx < stepIndex;
                const isCurrent = idx === stepIndex && isPipelineRunning;
                const isPending = idx > stepIndex;

                return (
                  <div
                    key={idx}
                    className={`p-3 rounded-xl border text-xs transition-all flex items-start gap-2.5 ${
                      isDone
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : isCurrent
                        ? 'bg-indigo-500/20 border-indigo-500/50 text-white animate-pulse'
                        : 'bg-slate-900/40 border-white/5 text-slate-500'
                    }`}
                  >
                    {isDone && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />}
                    {isCurrent && <RefreshCw className="w-4 h-4 text-indigo-400 animate-spin shrink-0 mt-0.5" />}
                    {isPending && <div className="w-4 h-4 rounded-full border border-slate-600 shrink-0 mt-0.5"></div>}
                    <span className="leading-snug">{step}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-3 rounded-xl bg-slate-900/80 border border-white/10 text-[11px] text-slate-400 flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Top 1% viral content filter ensures only proven hooks are reused.</span>
          </div>
        </div>
      </div>
    </div>
  );
};
