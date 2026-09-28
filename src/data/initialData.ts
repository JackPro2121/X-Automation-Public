import { Creator, ViralPost, BrandConfig, GeneratedPost, AudienceGap, APIKeys } from '../types';

export const INITIAL_CREATORS: Creator[] = [
  {
    id: 'c1',
    handle: 'rowancheung',
    name: 'Rowan Cheung',
    avatar: 'https://images.unsplash.com/photo-1531297122539-5692f69f2142?auto=format&fit=crop&w=150&q=80',
    category: 'AI News & Updates',
    followersCount: 450000,
    postsCount: 5200,
    bio: 'Founder @ The Rundown AI. Bringing you the latest in AI models, LLMs, and tech news before anyone else.',
    verified: true,
    lastScraped: '10 minutes ago',
    topViralityScore: 98
  },
  {
    id: 'c2',
    handle: '_akhaliq',
    name: 'AK',
    avatar: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=150&q=80',
    category: 'Open Source Models & Arxiv',
    followersCount: 380000,
    postsCount: 12000,
    bio: 'Machine Learning, AI Research, Open Source LLMs, HuggingFace & Arxiv papers.',
    verified: true,
    lastScraped: '1 hour ago',
    topViralityScore: 95
  },
  {
    id: 'c3',
    handle: 'swyx',
    name: 'swyx',
    avatar: 'https://images.unsplash.com/photo-1555949963-ff9fe0c870eb?auto=format&fit=crop&w=150&q=80',
    category: 'AI Engineering & Agents',
    followersCount: 195000,
    postsCount: 8900,
    bio: 'AI Engineer. Building AI agents, RAG systems, and exploring the future of software development.',
    verified: true,
    lastScraped: '3 hours ago',
    topViralityScore: 92
  }
];

export const INITIAL_CONFIGS: BrandConfig[] = [
  {
    id: 'config_ai_news',
    name: 'AI Daily News & Engineering Radar',
    category: 'AI Models & Tech News',
    targetICP: 'Tech Founders, Software Engineers, AI Builders looking for breaking LLM benchmarks, open-source models, and agentic workflows.',
    nicheFocus: 'Breaking AI Releases, DeepSeek, LLaMA-3, Claude Sonnet, Open Source LLMs, AI Agents, and Local Inference.',
    brandVoice: 'Fast-paced, cutting-edge, high-signal, authoritative, senior news editor style.',
    contentPillars: [
      'Breaking AI Model Releases (DeepSeek, Claude, Gemini, Llama)',
      'Open Source Tool & LLM Benchmark Spotlights',
      'AI Agent Frameworks & RAG Architecture Blueprints',
      'Future AI Trends & Edge Inference'
    ],
    hookAnalysisRules: [
      'Extract urgency and "breaking news" frames',
      'Identify listicles of top open-source tools',
      'Highlight performance metrics (parameter sizes, latency ms, benchmark scores)'
    ],
    customCTAs: [
      '🚀 Follow @M_jawad_yasin for daily AI benchmarks & model releases!',
      '📌 Bookmark this breakdown for your next AI engineering project.',
      '💡 Follow @M_jawad_yasin for cutting-edge LLM & agent architecture insights!'
    ],
    websiteUrl: 'https://x-automation-ebon.vercel.app',
    active: true
  }
];

export const INITIAL_VIRAL_POSTS: ViralPost[] = [
  {
    id: 'vp1',
    creatorHandle: 'rowancheung',
    creatorName: 'Rowan Cheung',
    creatorAvatar: 'https://images.unsplash.com/photo-1531297122539-5692f69f2142?auto=format&fit=crop&w=150&q=80',
    text: 'BREAKING: Open-source reasoning models just matched proprietary LLMs on complex math and coding benchmarks.\n\nWeights and local inference guides are live today.',
    likes: 12500,
    retweets: 3200,
    replies: 850,
    viralityScore: 99,
    hookType: 'Breaking News Hook',
    postUrl: 'https://x.com/rowancheung/status/17823901',
    postedAt: '2 hours ago',
    hasMedia: true,
    mediaType: 'image'
  },
  {
    id: 'vp2',
    creatorHandle: '_akhaliq',
    creatorName: 'AK',
    creatorAvatar: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=150&q=80',
    text: 'New open-source 70B model released today. Beats GPT-4 on coding benchmarks.\n\nWeights are available on HuggingFace. You can run this locally right now.',
    likes: 8100,
    retweets: 2140,
    replies: 410,
    viralityScore: 97,
    hookType: 'Open Source Release',
    postUrl: 'https://x.com/_akhaliq/status/17824102',
    postedAt: '5 hours ago',
    hasMedia: false,
    mediaType: 'none'
  }
];

export const INITIAL_GENERATED_POSTS: GeneratedPost[] = [
  {
    id: 'gp1',
    originalPostId: 'vp1',
    creatorHandle: 'rowancheung',
    creatorName: 'Rowan Cheung',
    creatorAvatar: 'https://images.unsplash.com/photo-1531297122539-5692f69f2142?auto=format&fit=crop&w=150&q=80',
    originalText: 'BREAKING: Open-source reasoning models just matched proprietary LLMs on complex math and coding benchmarks.',
    originalViralityScore: 99,
    originalHookType: 'Contrarian Reality Interrupt',
    
    generatedText: '🚨 Open-source LLMs just hit a major tipping point.\n\nRunning DeepSeek-R1 & LLaMA-3 locally via vLLM now cuts inference latency from 2.4s to 85ms — at 1/40th closed API costs.\n\nThe shift to edge AI is happening fast.\n\n🚀 Follow @M_jawad_yasin for daily AI benchmarks!',
    viralityHookTag: 'Contrarian Reality Interrupt',
    hookFormulaExplanation: 'Pattern interrupt hook targeting developer friction, contrasting legacy API costs with open-source local inference speed.',
    ctaIncluded: '🚀 Follow @M_jawad_yasin for daily AI benchmarks!',
    characterCount: 271,
    infographic: {
      title: 'AI Engineering Radar',
      subtitle: 'Legacy Wrappers vs Production AI Standard',
      items: [
        { leftText: 'Proprietary API Locks', rightText: 'Open Source 70B Local Weights', highlight: true },
        { leftText: 'Single-Prompt Chatbots', rightText: 'Autonomous Agentic RAG', highlight: true },
        { leftText: '2.4s Cloud Bottlenecks', rightText: '85ms Local Edge Inference', highlight: false }
      ],
      footerText: 'Execution velocity & low latency win in AI.',
      theme: 'indigo'
    },
    createdAt: 'Just now',
    status: 'approved'
  }
];

export const INITIAL_AUDIENCE_GAPS: AudienceGap[] = [
  {
    id: 'gap1',
    competitorHandle: 'swyx',
    originalPostSnippet: 'Building RAG systems is getting easier with new frameworks.',
    userReplyComment: 'I keep getting hallucinations in my RAG setup when the context window gets too large. How do I fix the retrieval quality?',
    unansweredPainPoint: 'RAG hallucination issues with large context retrieval.',
    suggestedCounterHook: 'Is your RAG system hallucinating? 3 advanced retrieval techniques to guarantee accurate context every time. (Thread 🧵)',
    demandScore: 95
  }
];

export const INITIAL_API_KEYS: APIKeys = {
  apifyKey: '',
  anthropicKey: '',
  geminiKey: '',
  openaiKey: ''
};
