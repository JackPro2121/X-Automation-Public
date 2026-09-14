import React, { useState, useRef, useEffect } from 'react';
import { Sliders, Save, Plus, Trash2, Globe, Sparkles, CheckCircle2, Target } from 'lucide-react';
import { BrandConfig } from '../../types';

interface ConfigStudioTabProps {
  configs: BrandConfig[];
  onSaveConfig: (config: BrandConfig) => void;
}

export const ConfigStudioTab: React.FC<ConfigStudioTabProps> = ({
  configs,
  onSaveConfig
}) => {
  const activeConfig = configs.find(c => c.active) || configs[0];

  const [formData, setFormData] = useState<BrandConfig>({ ...activeConfig });
  const [newPillar, setNewPillar] = useState('');
  const [newCTA, setNewCTA] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [isScrapingWebsite, setIsScrapingWebsite] = useState(false);
  const timeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach(t => clearTimeout(t));
    };
  }, []);

  const handlePillarAdd = () => {
    if (!newPillar.trim()) return;
    setFormData({
      ...formData,
      contentPillars: [...formData.contentPillars, newPillar.trim()]
    });
    setNewPillar('');
  };

  const handlePillarRemove = (index: number) => {
    setFormData({
      ...formData,
      contentPillars: formData.contentPillars.filter((_, i) => i !== index)
    });
  };

  const handleCTAAdd = () => {
    if (!newCTA.trim()) return;
    setFormData({
      ...formData,
      customCTAs: [...formData.customCTAs, newCTA.trim()]
    });
    setNewCTA('');
  };

  const handleCTARemove = (index: number) => {
    setFormData({
      ...formData,
      customCTAs: formData.customCTAs.filter((_, i) => i !== index)
    });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig({ ...formData, active: true });
    setSuccessMsg('Brand Strategy Config saved successfully!');
    const t = setTimeout(() => setSuccessMsg(''), 4000);
    timeoutRefs.current.push(t);
  };

  const handleSimulateWebsiteScrape = () => {
    if (!formData.websiteUrl) return;
    setIsScrapingWebsite(true);
    const t1 = setTimeout(() => {
      setIsScrapingWebsite(false);
      setFormData(prev => ({
        ...prev,
        brandVoice: 'Authoritative, Data-driven, High-Conversion Focus, direct ROI tone.',
        nicheFocus: 'Conversion Rate Optimization, E-Commerce Growth, User Psychology & A/B testing velocity.'
      }));
      setSuccessMsg('Website brand context scraped & populated automatically!');
      const t2 = setTimeout(() => setSuccessMsg(''), 4000);
      timeoutRefs.current.push(t2);
    }, 1500);
    timeoutRefs.current.push(t1);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Sliders className="w-5 h-5 text-purple-400" />
            Brand Context & Content Strategy Configs
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            Define your ICP, niche focus, tone of voice, and custom sales CTAs. The pipeline uses this DNA to adapt viral hooks into high-converting posts for your brand.
          </p>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Basic Brand Details & Website Scraper */}
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
            <Target className="w-4 h-4 text-indigo-400" />
            1. Brand Identity & ICP Positioning
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Strategy Config Name
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
                className="glass-input w-full"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Category Matching
              </label>
              <input
                type="text"
                value={formData.category}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                required
                className="glass-input w-full"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Target ICP (Ideal Customer Profile) Description
              </label>
              <textarea
                rows={2}
                value={formData.targetICP}
                onChange={(e) => setFormData({ ...formData, targetICP: e.target.value })}
                required
                placeholder="Describe your ideal client (e.g. 7-8 Figure E-Commerce Founders, CMOs, DTC Brand Owners)"
                className="glass-input w-full resize-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Niche Focus & Angle
              </label>
              <input
                type="text"
                value={formData.nicheFocus}
                onChange={(e) => setFormData({ ...formData, nicheFocus: e.target.value })}
                className="glass-input w-full"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Brand Tone of Voice
              </label>
              <input
                type="text"
                value={formData.brandVoice}
                onChange={(e) => setFormData({ ...formData, brandVoice: e.target.value })}
                className="glass-input w-full"
              />
            </div>

            {/* Auto Brand Website Context Scraper */}
            <div className="md:col-span-2 p-4 rounded-xl bg-indigo-500/10 border border-indigo-500/20 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-indigo-300 flex items-center gap-1.5">
                  <Globe className="w-4 h-4" />
                  Auto-Tuner: Extract Brand Context from Website URL
                </span>
                <button
                  type="button"
                  onClick={handleSimulateWebsiteScrape}
                  disabled={isScrapingWebsite || !formData.websiteUrl}
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  {isScrapingWebsite ? (
                    <>
                      <Sparkles className="w-3.5 h-3.5 animate-spin" />
                      Extracting DNA...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      Auto-Extract Brand DNA
                    </>
                  )}
                </button>
              </div>
              <input
                type="url"
                placeholder="https://yourcompany.com"
                value={formData.websiteUrl || ''}
                onChange={(e) => setFormData({ ...formData, websiteUrl: e.target.value })}
                className="glass-input w-full"
              />
            </div>
          </div>
        </div>

        {/* Content Pillars */}
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            2. Core Content Pillars
          </h3>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Add new pillar (e.g. User Psychology over Cosmetic Tweaks)"
              value={newPillar}
              onChange={(e) => setNewPillar(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePillarAdd(); } }}
              className="glass-input flex-1"
            />
            <button
              type="button"
              onClick={handlePillarAdd}
              className="btn-secondary text-xs"
            >
              <Plus className="w-4 h-4" />
              Add Pillar
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
            {formData.contentPillars.map((pillar, idx) => (
              <div
                key={idx}
                className="p-3 rounded-xl bg-slate-900/80 border border-white/10 flex items-center justify-between text-xs text-white"
              >
                <span>📌 {pillar}</span>
                <button
                  type="button"
                  onClick={() => handlePillarRemove(idx)}
                  className="text-slate-500 hover:text-rose-400 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Custom CTAs Injection */}
        <div className="glass-panel p-6 space-y-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2 border-b border-white/10 pb-3">
            <Globe className="w-4 h-4 text-amber-400" />
            3. Conversion CTAs (Sales Automation)
          </h3>

          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Add Call-To-Action (e.g. Reply AUDIT for free audit)"
              value={newCTA}
              onChange={(e) => setNewCTA(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCTAAdd(); } }}
              className="glass-input flex-1"
            />
            <button
              type="button"
              onClick={handleCTAAdd}
              className="btn-secondary text-xs"
            >
              <Plus className="w-4 h-4" />
              Add CTA
            </button>
          </div>

          <div className="space-y-2 pt-2">
            {formData.customCTAs.map((cta, idx) => (
              <div
                key={idx}
                className="p-3 rounded-xl bg-slate-900/80 border border-white/10 flex items-center justify-between text-xs text-amber-300"
              >
                <span>{cta}</span>
                <button
                  type="button"
                  onClick={() => handleCTARemove(idx)}
                  className="text-slate-500 hover:text-rose-400 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
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
            <span className="text-xs text-slate-400">
              Save your brand strategy to automatically tune all future content generation.
            </span>
          )}
          <button type="submit" className="btn-primary text-xs">
            <Save className="w-4 h-4" />
            Save Strategy Config
          </button>
        </div>
      </form>
    </div>
  );
};
