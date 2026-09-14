import React, { useState, useEffect, useCallback } from 'react';
import { Navbar } from './components/Navbar';
import { Sidebar } from './components/Sidebar';

// Tabs
import { DashboardTab } from './components/tabs/DashboardTab';
import { CompetitorsTab } from './components/tabs/CompetitorsTab';
import { ConfigStudioTab } from './components/tabs/ConfigStudioTab';
import { PipelineTab } from './components/tabs/PipelineTab';
import { ContentStudioTab } from './components/tabs/ContentStudioTab';
import { AudienceGapsTab } from './components/tabs/AudienceGapsTab';
import { SettingsTab } from './components/tabs/SettingsTab';

// Storage & Services
import { storageService } from './services/storage';
import { aiEngine } from './services/aiEngine';
import { 
  Creator, 
  BrandConfig, 
  GeneratedPost, 
  AudienceGap, 
  APIKeys, 
  PipelineSettings, 
  ActiveTab,
  ViralPost
} from './types';
import { INITIAL_CONFIGS } from './data/initialData';
import { Loader2 } from 'lucide-react';

export function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // App State
  const [creators, setCreators] = useState<Creator[]>([]);
  const [configs, setConfigs] = useState<BrandConfig[]>([]);
  const [generatedPosts, setGeneratedPosts] = useState<GeneratedPost[]>([]);
  const [gaps, setGaps] = useState<AudienceGap[]>([]);
  const [apiKeys, setApiKeys] = useState<APIKeys>({ apifyKey: '', anthropicKey: '', geminiKey: '', openaiKey: '' });
  const [pipelineSettings, setPipelineSettings] = useState<PipelineSettings>({ configId: '', postsPerCreator: 20, lookbackDays: 30, minViralityScore: 85, autoGenerateInfographics: true, includeCTAs: true });
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);

  // Extracted data loading function (used in useEffect and handleResetData)
  const loadAllData = useCallback(async () => {
    const [
      fetchedCreators,
      fetchedConfigs,
      fetchedPosts,
      fetchedGaps,
      fetchedKeys,
      fetchedPipeline
    ] = await Promise.all([
      storageService.getCreators(),
      storageService.getConfigs(),
      storageService.getGeneratedPosts(),
      storageService.getGaps(),
      storageService.getApiKeys(),
      storageService.getPipelineSettings()
    ]);

    setCreators(fetchedCreators);
    setConfigs(fetchedConfigs);
    setGeneratedPosts(fetchedPosts);
    setGaps(fetchedGaps);
    setApiKeys(fetchedKeys);
    setPipelineSettings(fetchedPipeline);
  }, []);

  // Initial Fetch from Supabase
  useEffect(() => {
    let cancelled = false;
    
    async function loadData() {
      setIsLoading(true);
      setError(null);
      try {
        await loadAllData();
      } catch (err) {
        console.error('Failed to load data:', err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load data');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    loadData();
    
    return () => { cancelled = true; };
  }, [loadAllData]);

  // Handlers (Async Saves to Supabase)
  const handleAddCreator = useCallback(async (creator: Creator, scrapedPosts?: ViralPost[]) => {
    setCreators(prev => [creator, ...prev]);
    try {
      await storageService.saveCreators([creator]);
      if (scrapedPosts?.length) {
        await storageService.saveViralPosts(scrapedPosts);
      }
    } catch (err) {
      console.error('Failed to save creator:', err);
      // Rollback optimistic update
      setCreators(prev => prev.filter(c => c.id !== creator.id));
    }
  }, []);

  const handleDeleteCreator = useCallback(async (id: string) => {
    const previous = creators;
    setCreators(prev => prev.filter(c => c.id !== id));
    try {
      await storageService.deleteCreator(id);
    } catch (err) {
      console.error('Failed to delete creator:', err);
      setCreators(previous);
    }
  }, [creators]);

  const handleSaveConfig = useCallback(async (config: BrandConfig) => {
    setConfigs(prev => prev.map(c => c.id === config.id ? config : c));
    try {
      await storageService.saveConfigs([config]);
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }, []);

  const handleRunPipeline = useCallback(async () => {
    setIsPipelineRunning(true);
    setError(null);

    try {
      const activeConfig = configs.find(c => c.active) || configs[0] || INITIAL_CONFIGS[0];
      const viralPosts = await storageService.getViralPosts();
      const eligible = viralPosts.filter(
        (vp) => vp.viralityScore >= pipelineSettings.minViralityScore
      );

      if (eligible.length === 0) {
        setIsPipelineRunning(false);
        return;
      }

      const newPosts: GeneratedPost[] = await Promise.all(
        eligible.map((vp) => aiEngine.generateRemixedPostAsync(vp, activeConfig))
      );

      setGeneratedPosts((prev) => [...newPosts, ...prev]);
      await storageService.saveGeneratedPosts(newPosts);
      setActiveTab('studio');
    } catch (err) {
      console.error('Pipeline failed:', err);
      setError(err instanceof Error ? err.message : 'Pipeline failed');
    } finally {
      setIsPipelineRunning(false);
    }
  }, [configs, pipelineSettings.minViralityScore]);

  const handleAddGap = useCallback(async (gap: AudienceGap) => {
    setGaps(prev => [gap, ...prev]);
    try {
      await storageService.saveGaps([gap]);
    } catch (err) {
      console.error('Failed to save gap:', err);
    }
  }, []);

  const handleConvertGapToPost = useCallback(async (gap: AudienceGap) => {
    const activeConfig = configs.find(c => c.active) || configs[0] || INITIAL_CONFIGS[0];
    const newPost: GeneratedPost = {
      id: 'gp_gap_' + Date.now(),
      originalPostId: 'gap_' + gap.id,
      creatorHandle: gap.competitorHandle,
      creatorName: gap.competitorHandle,
      creatorAvatar: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80',
      originalText: `User Reply: "${gap.userReplyComment}"`,
      originalViralityScore: gap.demandScore,
      originalHookType: 'Audience Objection Counter-Hook',
      generatedText: `${gap.suggestedCounterHook}\n\nHere is how to solve this for your brand:\n\n1. Focus on core buyer motivation\n2. Eliminate friction at checkout\n3. Leverage authentic social proof\n\n${activeConfig.customCTAs[0] || ''}`,
      viralityHookTag: 'Audience Objection Counter-Hook',
      hookFormulaExplanation: `Directly answers the real audience friction point mined from @${gap.competitorHandle} replies.`,
      ctaIncluded: activeConfig.customCTAs[0] || '',
      characterCount: 260,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'draft'
    };

    setGeneratedPosts(prev => [newPost, ...prev]);
    try {
      await storageService.saveGeneratedPosts([newPost]);
    } catch (err) {
      console.error('Failed to save converted post:', err);
    }
    setActiveTab('studio');
  }, [configs]);

  const handleUpdatePost = useCallback(async (updated: GeneratedPost) => {
    setGeneratedPosts(prev => prev.map(p => p.id === updated.id ? updated : p));
    try {
      await storageService.saveGeneratedPosts([updated]);
    } catch (err) {
      console.error('Failed to update post:', err);
    }
  }, []);

  const handleSaveApiKeys = useCallback(async (keys: APIKeys) => {
    setApiKeys(keys);
    try {
      await storageService.saveApiKeys(keys);
    } catch (err) {
      console.error('Failed to save API keys:', err);
    }
  }, []);

  const handleSavePipelineSettings = useCallback(async (settings: PipelineSettings) => {
    setPipelineSettings(settings);
    try {
      await storageService.savePipelineSettings(settings);
    } catch (err) {
      console.error('Failed to save pipeline settings:', err);
    }
  }, []);

  const handleResetData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      await storageService.resetToDefault();
      await loadAllData();
    } catch (err) {
      console.error('Failed to reset data:', err);
      setError(err instanceof Error ? err.message : 'Failed to reset data');
    } finally {
      setIsLoading(false);
    }
  }, [loadAllData]);

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0B0F17] flex-col gap-4">
        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
        <p className="text-slate-400 font-medium text-sm">Connecting to Supabase Database...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-screen w-full items-center justify-center bg-[#0B0F17] flex-col gap-4">
        <div className="glass-panel p-6 max-w-md text-center">
          <p className="text-red-400 font-medium mb-2">Error Loading Data</p>
          <p className="text-slate-400 text-sm mb-4">{error}</p>
          <button
            onClick={() => { setError(null); setIsLoading(true); loadAllData().finally(() => setIsLoading(false)); }}
            className="btn-primary text-xs"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Background Glowing Ambient Orbs */}
      <div className="bg-glow-container">
        <div className="bg-glow-1"></div>
        <div className="bg-glow-2"></div>
      </div>

      {/* Navbar Header */}
      <Navbar
        apiKeys={apiKeys}
        isPipelineRunning={isPipelineRunning}
        onRunPipelineClick={handleRunPipeline}
      />

      {/* Main Container */}
      <div className="main-content-wrapper">
        {/* Navigation Sidebar */}
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          generatedCount={generatedPosts.length}
          creatorsCount={creators.length}
          gapsCount={gaps.length}
        />

        {/* Tab Viewport */}
        <main className="tab-content">
          {activeTab === 'dashboard' && (
            <DashboardTab
              creators={creators}
              generatedPosts={generatedPosts}
              configs={configs}
              setActiveTab={setActiveTab}
              onRunPipeline={handleRunPipeline}
            />
          )}

          {activeTab === 'competitors' && (
            <CompetitorsTab
              creators={creators}
              onAddCreator={handleAddCreator}
              onDeleteCreator={handleDeleteCreator}
            />
          )}

          {activeTab === 'configs' && (
            <ConfigStudioTab
              configs={configs}
              onSaveConfig={handleSaveConfig}
            />
          )}

          {activeTab === 'pipeline' && (
            <PipelineTab
              settings={pipelineSettings}
              configs={configs}
              creators={creators}
              onSaveSettings={handleSavePipelineSettings}
              onRunPipeline={handleRunPipeline}
              isPipelineRunning={isPipelineRunning}
            />
          )}

          {activeTab === 'studio' && (
            <ContentStudioTab
              posts={generatedPosts}
              onUpdatePost={handleUpdatePost}
            />
          )}

          {activeTab === 'gaps' && (
            <AudienceGapsTab
              gaps={gaps}
              creators={creators}
              onAddGap={handleAddGap}
              onConvertGapToPost={handleConvertGapToPost}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              apiKeys={apiKeys}
              onSaveApiKeys={handleSaveApiKeys}
              onResetData={handleResetData}
            />
          )}
        </main>
      </div>
    </div>
  );
}
