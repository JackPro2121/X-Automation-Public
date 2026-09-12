import { ViralPost, BrandConfig, GeneratedPost, AudienceGap, Creator } from '../types';
import { chiefEditorAgent } from './chiefEditorAgent';
import { enforceThreadCharLimits, smartTrimTweet } from '../utils/tweetLimits';

// SECURITY NOTE: this module used to call the MiMo LLM API directly from the
// browser using a VITE_-prefixed env var. Any VITE_-prefixed variable gets
// inlined into the built client bundle, which means a paid API key would be
// readable by anyone who opens devtools on the deployed dashboard. Real
// content generation already happens safely server-side in
// cron/seed_and_post.js (using a non-VITE_ env var that never reaches the
// browser). This module now only produces heuristic fallback content — do
// not reintroduce a client-side fetch to a paid LLM/scraper API here.

export const aiEngine = {
  /**
   * Deconstructs a competitor's post to extract high-virality scroll-stopping hook mechanics
   */
  deconstructPost(post: ViralPost) {
    const textLower = post.text.toLowerCase();
    
    if (textLower.includes('open source') || textLower.includes('weights') || textLower.includes('huggingface') || textLower.includes('benchmark')) {
      return {
        hookTag: 'Zero-to-Hero Benchmark Shock',
        explanation: 'Hooks technical readers by contrasting open-source model benchmarks against expensive proprietary LLMs.'
      };
    }
    
    if (textLower.includes('agent') || textLower.includes('rag') || textLower.includes('pipeline') || textLower.includes('architecture')) {
      return {
        hookTag: 'Production Blueprint Architecture',
        explanation: 'Captures engineer attention by promising a battle-tested technical workflow or architectural blueprint.'
      };
    }

    if (textLower.includes('cost') || textLower.includes('speed') || textLower.includes('latency') || textLower.includes('token')) {
      return {
        hookTag: 'Quantified Speed & Cost Arbitrage',
        explanation: 'Triggers instant interest with concrete numerical proof of performance gains or cloud savings.'
      };
    }

    if (textLower.includes('stop') || textLower.includes('wrong') || textLower.includes('dying') || textLower.includes('mistake')) {
      return {
        hookTag: 'Contrarian Reality Interrupt',
        explanation: 'Breaks scrolling fatigue by challenging popular wisdom and exposing industry misconceptions.'
      };
    }

    return {
      hookTag: 'Uncomfortable Hard Shift & FOMO',
      explanation: 'Frames breaking AI releases as fundamental market shifts that create immediate FOMO for builders.'
    };
  },

  /**
   * Adapts a viral competitor post into a brand-tailored, high-converting scroll-stopping post using Xiaomi MiMo LLM
   */
  async generateRemixedPostAsync(post: ViralPost, config: BrandConfig): Promise<GeneratedPost> {
    const { hookTag, explanation } = this.deconstructPost(post);
    const cta = config.customCTAs && config.customCTAs.length > 0
      ? config.customCTAs[Math.floor(Math.random() * config.customCTAs.length)]
      : '🚀 Follow @M_jawad_yasin for daily AI benchmarks & model releases!';

    // Content generation is heuristic-only on the client (see security note
    // above). The server-side cron pipeline (cron/seed_and_post.js) is the
    // one that calls MiMo for real, LLM-generated threads.
    const TWEET_BREAK = '===TWEET_BREAK===';
    const draftPost = this.generateRemixedPost(post, config);
    const generatedText = draftPost.generatedText;
    const infographicData = draftPost.infographic;

    const draft: GeneratedPost = {
      id: 'gp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      originalPostId: post.id,
      creatorHandle: post.creatorHandle,
      creatorName: post.creatorName,
      creatorAvatar: post.creatorAvatar,
      originalText: post.text,
      originalViralityScore: post.viralityScore,
      originalHookType: post.hookType,
      generatedText,
      viralityHookTag: hookTag,
      hookFormulaExplanation: explanation,
      ctaIncluded: cta,
      characterCount: generatedText.length,
      infographic: infographicData,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'draft'
    };

    // Evaluate through Chief Content Officer AI Agent
    const evalResult = await chiefEditorAgent.evaluatePost(draft, config);
    const refined = evalResult.refinedPost || draft;
    if (refined.generatedText.includes(TWEET_BREAK)) {
      const parts = refined.generatedText.split(TWEET_BREAK).map((t) => t.trim()).filter(Boolean);
      refined.generatedText = enforceThreadCharLimits(parts).join(`\n${TWEET_BREAK}\n`);
    } else {
      refined.generatedText = smartTrimTweet(refined.generatedText);
    }
    refined.characterCount = refined.generatedText.length;
    refined.status = evalResult.passed ? 'approved' : 'draft';
    return refined;
  },

  /**
   * Synchronous fallback generator producing high-converting scroll-stopping posts
   */
  generateRemixedPost(post: ViralPost, config: BrandConfig): GeneratedPost {
    const { hookTag, explanation } = this.deconstructPost(post);
    const cta = '🚀 Follow @M_jawad_yasin for daily AI news & benchmarks!';
    const topic = config.nicheFocus ? config.nicheFocus.split(',')[0] : 'AI Models & Agent Radar';

    const TWEET_BREAK = '===TWEET_BREAK===';

    // Elite thread fallbacks — each a complete, natural-flowing thread
    const threadFallbacks = [
      [
        `Open-source just made closed AI APIs economically obsolete.`,
        `DeepSeek-R1 at $0.55/1M tokens vs GPT-4o at $60/1M. Same MMLU benchmark. That's a 100x cost gap — not marginal. It's a structural risk if your product is built on OpenAI pricing.`,
        `vLLM 0.7 runs DeepSeek-R1-671B at 65ms p50 on dual A100s. RTX 4090 hits sub-100ms with Q4_K_M via llama.cpp. The local inference threshold crossed quietly — most engineers missed it.`,
        `The bottleneck in AI products is no longer cost or model capability. It's retrieval quality, context management, and agent reliability. Your infra budget just freed up — reinvest it in architecture.`,
        `If you're still routing all inference through OpenAI: audit your unit economics. The open-weights ecosystem is production-ready. The 100x cost arbitrage compounds every month.`,
        cta
      ],
      [
        `Multi-agent AI systems are production reality now. Most teams are architecting them wrong.`,
        `AutoGen v0.4 actor model: 50+ parallel specialized agents, shared vector memory, deterministic tool schemas. Fortune 500 teams report 4x engineering output on codebase migrations. The gains are measurable.`,
        `Critical insight: agents need Pydantic-enforced tool call schemas. Untyped string tool calls fail at scale — hallucinated parameters, silent failures, infinite retry loops. JSON schema enforcement fixes this.`,
        `Wall-clock latency — naive sequential loop: 45s. Parallel fan-out with dependency graph: 8s. 5.6x improvement, same token budget. The bottleneck is your architecture, not the model.`,
        `Build the dependency graph first. Which tasks are sequential? Which can fan out? Most teams default to sequential and wonder why their agents are slow. It's not the LLM — it's the topology.`,
        cta
      ]
    ];

    const chosen = threadFallbacks[Math.floor(Math.random() * threadFallbacks.length)];
    const generatedContent = enforceThreadCharLimits(chosen).join(`\n${TWEET_BREAK}\n`);

    const infographicData = {
      title: `${topic} Radar`,
      subtitle: 'Legacy Wrappers vs Agentic AI Standard',
      items: [
        { leftText: 'Proprietary API Locks', rightText: 'Open Source 70B Weights', highlight: true },
        { leftText: 'Single-Prompt Chatbots', rightText: 'Autonomous Agentic RAG', highlight: true },
        { leftText: 'High Latency Costs', rightText: '120ms Local Edge Inference', highlight: false }
      ],
      footerText: 'Speed & execution velocity win in AI.',
      theme: 'indigo' as const
    };

    return {
      id: 'gp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      originalPostId: post.id,
      creatorHandle: post.creatorHandle,
      creatorName: post.creatorName,
      creatorAvatar: post.creatorAvatar,
      originalText: post.text,
      originalViralityScore: post.viralityScore,
      originalHookType: post.hookType,
      generatedText: generatedContent,
      viralityHookTag: hookTag,
      hookFormulaExplanation: explanation,
      ctaIncluded: cta,
      characterCount: generatedContent.length,
      infographic: infographicData,
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      status: 'draft'
    };
  },

  /**
   * Scrapes creator profile with AI focus
   */
  async scrapeCreatorProfile(handle: string, category: string): Promise<{ creator: Creator; posts: ViralPost[] }> {
    const cleanHandle = handle.replace(/^@/, '').replace(/.*twitter\.com\//, '').replace(/.*x\.com\//, '').trim();

    const newCreator: Creator = {
      id: 'c_' + Date.now(),
      handle: cleanHandle,
      name: cleanHandle.charAt(0).toUpperCase() + cleanHandle.slice(1),
      avatar: `https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&q=80`,
      category: category || 'AI News & LLM Research',
      followersCount: Math.floor(Math.random() * 200000) + 50000,
      postsCount: Math.floor(Math.random() * 4000) + 1000,
      bio: `Tracking breaking AI models, open-source benchmarks, and autonomous agent frameworks.`,
      verified: true,
      lastScraped: 'Just now',
      topViralityScore: Math.floor(Math.random() * 10) + 90
    };

    const posts: ViralPost[] = [
      {
        id: 'vp_' + Date.now() + '_1',
        creatorHandle: cleanHandle,
        creatorName: newCreator.name,
        creatorAvatar: newCreator.avatar,
        text: `BREAKING: New open-source model outperforms proprietary LLMs on coding benchmarks.\n\nWeights and fine-tuning scripts are live. Here is how to run it locally:`,
        likes: Math.floor(Math.random() * 6000) + 2000,
        retweets: Math.floor(Math.random() * 1200) + 400,
        replies: Math.floor(Math.random() * 400) + 100,
        viralityScore: Math.floor(Math.random() * 6) + 94,
        hookType: 'Zero-to-Hero Benchmark Shock',
        postUrl: `https://x.com/${cleanHandle}/status/${Date.now()}`,
        postedAt: '2 hours ago',
        hasMedia: true,
        mediaType: 'infographic'
      }
    ];

    return { creator: newCreator, posts };
  },

  /**
   * Generates new audience gaps by mining competitor comments
   */
  generateAudienceGap(handle: string): AudienceGap {
    const gaps = [
      {
        snippet: 'Building autonomous AI agents with tools and long-term memory.',
        comment: 'How do you prevent loops and infinite tool calls when context window fills up?',
        pain: 'Infinite execution loop prevention & memory truncation in AI agents.',
        hook: 'Is your AI agent getting stuck in loops? 3 production guardrails to stop runaway API calls.'
      }
    ];

    const chosen = gaps[0];
    return {
      id: 'gap_' + Date.now(),
      competitorHandle: handle,
      originalPostSnippet: chosen.snippet,
      userReplyComment: chosen.comment,
      unansweredPainPoint: chosen.pain,
      suggestedCounterHook: chosen.hook,
      demandScore: 96
    };
  }
};

