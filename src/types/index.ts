export interface Creator {
  id: string;
  handle: string;
  name: string;
  avatar: string;
  category: string;
  followersCount: number;
  postsCount: number;
  bio: string;
  verified: boolean;
  lastScraped: string;
  topViralityScore: number;
}

export interface ViralPost {
  id: string;
  creatorHandle: string;
  creatorName: string;
  creatorAvatar: string;
  text: string;
  likes: number;
  retweets: number;
  replies: number;
  viralityScore: number;
  hookType: string;
  postUrl: string;
  postedAt: string;
  hasMedia: boolean;
  mediaType: 'none' | 'infographic' | 'image';
}

export interface BrandConfig {
  id: string;
  name: string;
  category: string;
  targetICP: string;
  nicheFocus: string;
  brandVoice: string;
  contentPillars: string[];
  hookAnalysisRules: string[];
  customCTAs: string[];
  websiteUrl?: string;
  active: boolean;
}

export interface InfographicData {
  title: string;
  subtitle: string;
  items: {
    leftText: string;
    rightText: string;
    highlight?: boolean;
  }[];
  footerText: string;
  theme: 'indigo' | 'emerald' | 'dark' | 'contrast';
}

export interface GeneratedPost {
  id: string;
  originalPostId: string;
  creatorHandle: string;
  creatorName: string;
  creatorAvatar: string;
  originalText: string;
  originalViralityScore: number;
  originalHookType: string;
  
  // Generated content
  generatedText: string;
  viralityHookTag: string;
  hookFormulaExplanation: string;
  ctaIncluded: string;
  characterCount: number;
  infographic?: InfographicData;
  createdAt: string;
  status: 'draft' | 'approved' | 'scheduled' | 'published' | 'posting' | 'failed';
  sourceUrl?: string;
  bufferPostId?: string;
  retryCount?: number;
  claimedAt?: string;
}

export interface AudienceGap {
  id: string;
  competitorHandle: string;
  originalPostSnippet: string;
  userReplyComment: string;
  unansweredPainPoint: string;
  suggestedCounterHook: string;
  demandScore: number; // 1-100
}

export interface PipelineSettings {
  configId: string;
  postsPerCreator: number;
  lookbackDays: number;
  minViralityScore: number;
  autoGenerateInfographics: boolean;
  includeCTAs: boolean;
}

export interface APIKeys {
  apifyKey: string;
  anthropicKey: string;
  geminiKey: string;
  openaiKey: string;
  mimoKey?: string;
}

export type ActiveTab = 'dashboard' | 'competitors' | 'configs' | 'pipeline' | 'studio' | 'gaps' | 'settings';
