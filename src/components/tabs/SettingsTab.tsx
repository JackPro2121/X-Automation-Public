import React, { useState, useRef, useEffect } from 'react';
import { Settings as SettingsIcon, Key, Save, CheckCircle2, RefreshCw, Lock, ShieldCheck, Database } from 'lucide-react';
import { APIKeys } from '../../types';

interface SettingsTabProps {
  apiKeys: APIKeys;
  onSaveApiKeys: (keys: APIKeys) => void;
  onResetData: () => void;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  apiKeys,
  onSaveApiKeys,
  onResetData
}) => {
  const [formData, setFormData] = useState<APIKeys>({ ...apiKeys });
  const [successMsg, setSuccessMsg] = useState('');
  const [showKeys, setShowKeys] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMsg('Nothing was saved. Live keys are managed only in GitHub Secrets.');
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setSuccessMsg(''), 4000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <SettingsIcon className="w-5 h-5 text-slate-400" />
            API Connections & System Settings
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            These external API keys are not currently used by the live pipeline — real content generation runs server-side via the GitHub Actions cron job (OpenRouter + Groq), which reads its own keys from repo secrets, never from this dashboard. Saving here is currently non-functional (see note below).
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* API Keys Panel */}
        <div className="glass-panel p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Key className="w-4 h-4 text-indigo-400" />
              External API Integrations
            </h3>
            <button
              type="button"
              onClick={() => setShowKeys(!showKeys)}
              className="text-xs text-indigo-400 hover:underline cursor-pointer"
            >
              {showKeys ? 'Hide Key Characters' : 'Show Key Characters'}
            </button>
          </div>

          <div className="space-y-4">
            {/* Apify Key */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                <span>1. Apify API Token (currently unused — not wired to any live feature)</span>
                <a href="https://apify.com" target="_blank" rel="noreferrer" className="text-[11px] text-indigo-400 hover:underline">Get key from apify.com</a>
              </label>
              <input
                type={showKeys ? 'text' : 'password'}
                placeholder="apify_api_..."
                value={formData.apifyKey}
                onChange={(e) => setFormData({ ...formData, apifyKey: e.target.value })}
                className="glass-input w-full font-mono text-xs"
              />
            </div>

            {/* Anthropic Key */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                <span>2. Anthropic Claude API Key (currently unused — not wired to any live feature)</span>
                <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-[11px] text-indigo-400 hover:underline">console.anthropic.com</a>
              </label>
              <input
                type={showKeys ? 'text' : 'password'}
                placeholder="sk-ant-api03-xxxxxxxxxxxxxxxxxxxx"
                value={formData.anthropicKey}
                onChange={(e) => setFormData({ ...formData, anthropicKey: e.target.value })}
                className="glass-input w-full font-mono text-xs"
              />
            </div>

            {/* Gemini Key */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                <span>3. Google Gemini API Key (currently unused — not wired to any live feature)</span>
                <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-[11px] text-indigo-400 hover:underline">aistudio.google.com</a>
              </label>
              <input
                type={showKeys ? 'text' : 'password'}
                placeholder="AIzaSyxxxxxxxxxxxxxxxxxxxx"
                value={formData.geminiKey}
                onChange={(e) => setFormData({ ...formData, geminiKey: e.target.value })}
                className="glass-input w-full font-mono text-xs"
              />
            </div>

            {/* OpenAI Key */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center justify-between">
                <span>4. OpenAI API Key (currently unused — not wired to any live feature)</span>
                <a href="https://platform.openai.com" target="_blank" rel="noreferrer" className="text-[11px] text-indigo-400 hover:underline">platform.openai.com</a>
              </label>
              <input
                type={showKeys ? 'text' : 'password'}
                placeholder="sk-proj-xxxxxxxxxxxxxxxxxxxx"
                value={formData.openaiKey}
                onChange={(e) => setFormData({ ...formData, openaiKey: e.target.value })}
                className="glass-input w-full font-mono text-xs"
              />
            </div>
          </div>
        </div>

        {/* Security & Local Storage Controls */}
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
            <Database className="w-4 h-4 text-rose-400" />
            Data Management & Storage Reset
          </h3>

          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-white">Reset Application Data</div>
              <p className="text-xs text-slate-400 mt-0.5">
                Restores default initial demo creators, brand strategy configs, and sample viral remixed posts.
              </p>
            </div>
            <button
              type="button"
              disabled
              title="Disabled until authenticated dashboard access is implemented"
              className="btn-secondary text-xs text-slate-500 border-slate-700 cursor-not-allowed opacity-60"
            >
              Reset Disabled
            </button>
          </div>
        </div>

        {/* Save Bar */}
        <div className="flex items-center justify-between glass-panel p-4 sticky bottom-4 z-40 bg-[#0B0F17]/90 backdrop-blur-xl">
          {successMsg ? (
            <div className="text-xs text-emerald-400 font-medium flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              {successMsg}
            </div>
          ) : (
            <span className="text-xs text-slate-400 flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-slate-500" />
              These fields no longer save to the database (the `api_keys` table was locked down to server-side access only, since it previously leaked to anyone via the public anon key). Never commit `.env.local`.
            </span>
          )}
          <button type="submit" className="btn-primary text-xs">
            <Save className="w-4 h-4" />
            GitHub Secrets Only
          </button>
        </div>
      </form>
    </div>
  );
};
