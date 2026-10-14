import { supabase } from './supabaseClient';
import { Creator, ViralPost, BrandConfig, GeneratedPost, AudienceGap, APIKeys, PipelineSettings } from '../types';
import { INITIAL_CREATORS, INITIAL_CONFIGS, INITIAL_VIRAL_POSTS, INITIAL_GENERATED_POSTS, INITIAL_AUDIENCE_GAPS, INITIAL_API_KEYS } from '../data/initialData';

export const storageService = {
  
  // ==================== CREATORS ====================
  async getCreators(): Promise<Creator[]> {
    const { data, error } = await supabase.from('creators').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error('Error fetching creators:', error);
      return [];
    }
    // If empty, optionally seed
    if (!data || data.length === 0) {
      await this.saveCreators(INITIAL_CREATORS);
      return INITIAL_CREATORS;
    }
    return data.map(c => ({
      id: c.id,
      handle: c.handle,
      name: c.name,
      avatar: c.avatar,
      category: c.category,
      followersCount: c.followers_count,
      postsCount: c.posts_count,
      bio: c.bio,
      verified: c.verified,
      lastScraped: c.last_scraped,
      topViralityScore: c.top_virality_score
    }));
  },

  async saveCreators(creators: Creator[]) {
    if (!creators.length) return;
    const { error } = await supabase.from('creators').upsert(
      creators.map(c => ({
        id: c.id,
        handle: c.handle,
        name: c.name,
        avatar: c.avatar,
        category: c.category,
        followers_count: c.followersCount,
        posts_count: c.postsCount,
        bio: c.bio,
        verified: c.verified,
        last_scraped: c.lastScraped,
        top_virality_score: c.topViralityScore
      }))
    );
    if (error) console.error('Error saving creators:', error);
  },

  async deleteCreator(id: string) {
    const { error } = await supabase.from('creators').delete().eq('id', id);
    if (error) console.error('Error deleting creator:', error);
  },

  // ==================== CONFIGS ====================
  async getConfigs(): Promise<BrandConfig[]> {
    const { data, error } = await supabase.from('configs').select('*');
    if (error) {
      console.error('Error fetching configs:', error);
      return [];
    }
    if (!data || data.length === 0) {
      await this.saveConfigs(INITIAL_CONFIGS);
      return INITIAL_CONFIGS;
    }
    return data.map(c => ({
      id: c.id,
      name: c.name,
      category: c.category,
      targetICP: c.target_icp,
      nicheFocus: c.niche_focus,
      brandVoice: c.brand_voice,
      contentPillars: c.content_pillars || [],
      hookAnalysisRules: c.hook_analysis_rules || [],
      customCTAs: c.custom_ctas || [],
      websiteUrl: c.website_url,
      active: c.active
    }));
  },

  async saveConfigs(configs: BrandConfig[]) {
    if (!configs.length) return;
    const { error } = await supabase.from('configs').upsert(
      configs.map(c => ({
        id: c.id,
        name: c.name,
        category: c.category,
        target_icp: c.targetICP,
        niche_focus: c.nicheFocus,
        brand_voice: c.brandVoice,
        content_pillars: c.contentPillars,
        hook_analysis_rules: c.hookAnalysisRules,
        custom_ctas: c.customCTAs,
        website_url: c.websiteUrl,
        active: c.active
      }))
    );
    if (error) console.error('Error saving configs:', error);
  },

  // ==================== VIRAL POSTS ====================
  async getViralPosts(): Promise<ViralPost[]> {
    const { data, error } = await supabase.from('viral_posts').select('*').order('created_at', { ascending: false });
    if (error) return [];
    if (!data || data.length === 0) {
      await this.saveViralPosts(INITIAL_VIRAL_POSTS);
      return INITIAL_VIRAL_POSTS;
    }
    return data.map(p => ({
      id: p.id,
      creatorHandle: p.creator_handle,
      creatorName: p.creator_name,
      creatorAvatar: p.creator_avatar,
      text: p.text,
      likes: p.likes,
      retweets: p.retweets,
      replies: p.replies,
      viralityScore: p.virality_score,
      hookType: p.hook_type,
      postUrl: p.post_url,
      postedAt: p.posted_at,
      hasMedia: p.has_media,
      mediaType: (p.media_type || 'none') as 'none' | 'infographic' | 'image'
    }));
  },

  async saveViralPosts(posts: ViralPost[]) {
    if (!posts.length) return;
    const { error } = await supabase.from('viral_posts').upsert(
      posts.map(p => ({
        id: p.id,
        creator_handle: p.creatorHandle,
        creator_name: p.creatorName,
        creator_avatar: p.creatorAvatar,
        text: p.text,
        likes: p.likes,
        retweets: p.retweets,
        replies: p.replies,
        virality_score: p.viralityScore,
        hook_type: p.hookType,
        post_url: p.postUrl,
        posted_at: p.postedAt,
        has_media: p.hasMedia,
        media_type: p.mediaType
      }))
    );
    if (error) console.error('Error saving viral posts:', error);
  },

  // ==================== GENERATED POSTS ====================
  async getGeneratedPosts(): Promise<GeneratedPost[]> {
    const { data, error } = await supabase.from('generated_posts').select('*').order('db_created_at', { ascending: false });
    if (error) return [];
    if (!data || data.length === 0) {
      await this.saveGeneratedPosts(INITIAL_GENERATED_POSTS);
      return INITIAL_GENERATED_POSTS;
    }
    return data.map(p => ({
      id: p.id,
      originalPostId: p.original_post_id,
      creatorHandle: p.creator_handle,
      creatorName: p.creator_name,
      creatorAvatar: p.creator_avatar,
      originalText: p.original_text,
      originalViralityScore: p.original_virality_score,
      originalHookType: p.original_hook_type,
      generatedText: p.generated_text,
      viralityHookTag: p.virality_hook_tag,
      hookFormulaExplanation: p.hook_formula_explanation,
      ctaIncluded: p.cta_included,
      characterCount: p.character_count,
      infographic: p.infographic,
      createdAt: p.created_at,
      status: (p.status || 'draft') as 'draft' | 'approved' | 'scheduled' | 'published' | 'posting' | 'failed',
      sourceUrl: p.source_url ?? undefined,
      bufferPostId: p.buffer_post_id ?? undefined,
      retryCount: p.retry_count ?? undefined,
      claimedAt: p.claimed_at ?? undefined
    }));
  },

  async saveGeneratedPosts(posts: GeneratedPost[]) {
    if (!posts.length) return;
    const { error } = await supabase.from('generated_posts').upsert(
      posts.map(p => ({
        id: p.id,
        original_post_id: p.originalPostId,
        creator_handle: p.creatorHandle,
        creator_name: p.creatorName,
        creator_avatar: p.creatorAvatar,
        original_text: p.originalText,
        original_virality_score: p.originalViralityScore,
        original_hook_type: p.originalHookType,
        generated_text: p.generatedText,
        virality_hook_tag: p.viralityHookTag,
        hook_formula_explanation: p.hookFormulaExplanation,
        cta_included: p.ctaIncluded,
        character_count: p.characterCount,
        infographic: p.infographic,
        created_at: p.createdAt,
        status: p.status,
        source_url: p.sourceUrl ?? null,
        buffer_post_id: p.bufferPostId ?? null,
        retry_count: p.retryCount ?? 0,
        claimed_at: p.claimedAt ?? null
      }))
    );
    if (error) console.error('Error saving generated posts:', error);
  },

  // ==================== GAPS ====================
  async getGaps(): Promise<AudienceGap[]> {
    const { data, error } = await supabase.from('audience_gaps').select('*').order('created_at', { ascending: false });
    if (error) return [];
    if (!data || data.length === 0) {
      await this.saveGaps(INITIAL_AUDIENCE_GAPS);
      return INITIAL_AUDIENCE_GAPS;
    }
    return data.map(g => ({
      id: g.id,
      competitorHandle: g.competitor_handle,
      originalPostSnippet: g.original_post_snippet,
      userReplyComment: g.user_reply_comment,
      unansweredPainPoint: g.unanswered_pain_point,
      suggestedCounterHook: g.suggested_counter_hook,
      demandScore: g.demand_score
    }));
  },

  async saveGaps(gaps: AudienceGap[]) {
    if (!gaps.length) return;
    const { error } = await supabase.from('audience_gaps').upsert(
      gaps.map(g => ({
        id: g.id,
        competitor_handle: g.competitorHandle,
        original_post_snippet: g.originalPostSnippet,
        user_reply_comment: g.userReplyComment,
        unanswered_pain_point: g.unansweredPainPoint,
        suggested_counter_hook: g.suggestedCounterHook,
        demand_score: g.demandScore
      }))
    );
    if (error) console.error('Error saving gaps:', error);
  },

  // ==================== SETTINGS ====================
  async getApiKeys(): Promise<APIKeys> {
    const { data, error } = await supabase.from('api_keys').select('*').eq('id', 'default').single();
    if (error || !data) return INITIAL_API_KEYS;
    return {
      apifyKey: data.apify_key || '',
      anthropicKey: data.anthropic_key || '',
      geminiKey: data.gemini_key || '',
      openaiKey: data.openai_key || ''
    };
  },

  async saveApiKeys(keys: APIKeys) {
    const { error } = await supabase.from('api_keys').upsert({
      id: 'default',
      apify_key: keys.apifyKey,
      anthropic_key: keys.anthropicKey,
      gemini_key: keys.geminiKey,
      openai_key: keys.openaiKey
    });
    if (error) console.error('Error saving api keys:', error);
  },

  async getPipelineSettings(): Promise<PipelineSettings> {
    const { data, error } = await supabase.from('pipeline_settings').select('*').eq('id', 'default').single();
    const fallback = {
      configId: INITIAL_CONFIGS[0].id,
      postsPerCreator: 20,
      lookbackDays: 30,
      minViralityScore: 85,
      autoGenerateInfographics: true,
      includeCTAs: true
    };
    if (error || !data) return fallback;
    return {
      configId: data.config_id || fallback.configId,
      postsPerCreator: data.posts_per_creator ?? fallback.postsPerCreator,
      lookbackDays: data.lookback_days ?? fallback.lookbackDays,
      minViralityScore: data.min_virality_score ?? fallback.minViralityScore,
      autoGenerateInfographics: data.auto_generate_infographics ?? fallback.autoGenerateInfographics,
      includeCTAs: data.include_ctas ?? fallback.includeCTAs
    };
  },

  async savePipelineSettings(settings: PipelineSettings) {
    const { error } = await supabase.from('pipeline_settings').upsert({
      id: 'default',
      config_id: settings.configId,
      posts_per_creator: settings.postsPerCreator,
      lookback_days: settings.lookbackDays,
      min_virality_score: settings.minViralityScore,
      auto_generate_infographics: settings.autoGenerateInfographics,
      include_ctas: settings.includeCTAs
    });
    if (error) console.error('Error saving pipeline settings:', error);
  },

  async resetToDefault() {
    // Clear all tables
    await supabase.from('creators').delete().neq('id', '0');
    await supabase.from('configs').delete().neq('id', '0');
    await supabase.from('viral_posts').delete().neq('id', '0');
    await supabase.from('generated_posts').delete().neq('id', '0');
    await supabase.from('audience_gaps').delete().neq('id', '0');
    await supabase.from('api_keys').delete().neq('id', '0');
    await supabase.from('pipeline_settings').delete().neq('id', '0');
    
    // Reseed
    await this.saveCreators(INITIAL_CREATORS);
    await this.saveConfigs(INITIAL_CONFIGS);
    await this.saveViralPosts(INITIAL_VIRAL_POSTS);
    await this.saveGeneratedPosts(INITIAL_GENERATED_POSTS);
    await this.saveGaps(INITIAL_AUDIENCE_GAPS);
  }
};
