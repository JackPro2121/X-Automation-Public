import React, { useState, useRef, useEffect } from 'react';
import { 
  Sparkles, 
  Copy, 
  Check, 
  ArrowRight, 
  ThumbsUp, 
  Share2, 
  MessageCircle, 
  TrendingUp, 
  Search, 
  Edit3
} from 'lucide-react';
import { GeneratedPost } from '../../types';
import { InfographicCanvas } from '../InfographicCanvas';
import { enforceThreadCharLimits, smartTrimTweet, X_MAX_CHARS } from '../../utils/tweetLimits';

interface ContentStudioTabProps {
  posts: GeneratedPost[];
  onUpdatePost: (post: GeneratedPost) => void;
}

export const ContentStudioTab: React.FC<ContentStudioTabProps> = ({
  posts,
  onUpdatePost
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [editingPostId, setEditingPostId] = useState<string | null>(null);
  const [editedText, setEditedText] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopiedId(null), 2500);
  };

  const handleStartEdit = (post: GeneratedPost) => {
    setEditingPostId(post.id);
    setEditedText(post.generatedText);
  };

  const handleSaveEdit = (post: GeneratedPost) => {
    let text = editedText;
    if (text.includes('===TWEET_BREAK===')) {
      const parts = text.split('===TWEET_BREAK===').map((t) => t.trim()).filter(Boolean);
      text = enforceThreadCharLimits(parts).join('\n===TWEET_BREAK===\n');
    } else {
      text = smartTrimTweet(text);
    }
    onUpdatePost({
      ...post,
      generatedText: text,
      characterCount: text.length
    });
    setEditingPostId(null);
  };

  const filteredPosts = posts.filter(p =>
    p.generatedText.toLowerCase().includes(searchFilter.toLowerCase()) ||
    p.originalText.toLowerCase().includes(searchFilter.toLowerCase()) ||
    p.creatorHandle.toLowerCase().includes(searchFilter.toLowerCase()) ||
    p.viralityHookTag.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-400" />
            Side-by-Side Content Remix Studio
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            Compare original competitor viral tweets on the left with your brand-tailored, high-converting posts and visual infographics on the right.
          </p>
        </div>
        <div className="text-xs text-slate-400 bg-slate-900/80 border border-white/10 px-3.5 py-2 rounded-xl">
          Showing <strong className="text-indigo-400">{filteredPosts.length}</strong> remixed posts
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search posts by keyword, handle, or hook formula..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="glass-input w-full pl-9"
          />
        </div>
      </div>

      {/* Side-by-Side Feed Grid */}
      <div className="space-y-8">
        {filteredPosts.map((post) => (
          <div
            key={post.id}
            className="glass-panel p-6 border-indigo-500/20 glass-panel-hover space-y-4"
          >
            {/* Top Hook Deconstruction Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-white/10 pb-3">
              <div className="flex items-center gap-2">
                <span className="badge badge-indigo text-xs">
                  ⚡ {post.viralityHookTag}
                </span>
                <span className="text-xs text-slate-400">
                  Adapted from <strong className="text-white">@{post.creatorHandle}</strong>
                </span>
              </div>
              <span className="text-xs text-slate-500">{post.createdAt}</span>
            </div>

            {/* Hook Explanation Note */}
            <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-xs text-indigo-300">
              💡 <strong>Hook Breakdown:</strong> {post.hookFormulaExplanation}
            </div>

            {/* Side by Side Card Container */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* LEFT CARD: Original Viral Tweet */}
              <div className="p-5 rounded-2xl bg-slate-950/80 border border-white/10 space-y-4 flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <img
                        src={post.creatorAvatar}
                        alt={post.creatorName}
                        className="w-10 h-10 rounded-full object-cover border border-white/10"
                      />
                      <div>
                        <div className="text-sm font-bold text-white">{post.creatorName}</div>
                        <div className="text-xs text-slate-400">@{post.creatorHandle}</div>
                      </div>
                    </div>
                    <span className="badge badge-amber text-[10px]">
                      🔥 Virality Score: {post.originalViralityScore}
                    </span>
                  </div>

                  <div className="text-xs text-slate-400 font-semibold uppercase tracking-wider">
                    Original Competitor Tweet (Viral Winner)
                  </div>

                  <p className="text-sm text-slate-300 whitespace-pre-line leading-relaxed font-normal bg-slate-900/50 p-3.5 rounded-xl border border-white/5">
                    {post.originalText}
                  </p>
                </div>

                {/* Viral Engagement Metrics */}
                <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
                  <div className="flex items-center gap-4">
                    <span className="flex items-center gap-1.5 text-rose-400">
                      <ThumbsUp className="w-3.5 h-3.5" /> 4.8k Likes
                    </span>
                    <span className="flex items-center gap-1.5 text-indigo-400">
                      <Share2 className="w-3.5 h-3.5" /> 930 Retweets
                    </span>
                    <span className="flex items-center gap-1.5 text-emerald-400">
                      <MessageCircle className="w-3.5 h-3.5" /> 245 Replies
                    </span>
                  </div>
                </div>
              </div>

              {/* RIGHT CARD: Your Tailored Brand Remix Post */}
              <div className="p-5 rounded-2xl bg-gradient-to-b from-slate-900 to-indigo-950/40 border border-indigo-500/30 space-y-4 flex flex-col justify-between shadow-xl">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 flex items-center justify-center font-bold text-white text-xs">
                        YOU
                      </div>
                      <div>
                        <div className="text-sm font-bold text-white">Your Brand Account</div>
                        <div className="text-xs text-indigo-300">Tailored to your ICP</div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleCopy(post.id, post.generatedText)}
                      className={`btn-emerald text-xs py-1.5 px-3 flex items-center gap-1.5 cursor-pointer ${
                        copiedId === post.id ? 'bg-emerald-600' : ''
                      }`}
                    >
                      {copiedId === post.id ? (
                        <>
                          <Check className="w-3.5 h-3.5" /> Copied to Clipboard!
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" /> Copy Post
                        </>
                      )}
                    </button>
                  </div>

                  <div className="text-xs text-indigo-300 font-semibold uppercase tracking-wider flex items-center justify-between">
                    <span>Generated Tailored Tweet</span>
                    <button
                      onClick={() => handleStartEdit(post)}
                      className="text-xs text-slate-400 hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      <Edit3 className="w-3 h-3" /> Edit Copy
                    </button>
                  </div>

                  {editingPostId === post.id ? (
                    <div className="space-y-2">
                      <textarea
                        rows={6}
                        value={editedText}
                        onChange={(e) => setEditedText(e.target.value)}
                        className="glass-input w-full text-sm resize-none"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setEditingPostId(null)}
                          className="btn-secondary text-xs py-1 px-3"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSaveEdit(post)}
                          className="btn-primary text-xs py-1 px-3"
                        >
                          Save Changes
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-white whitespace-pre-line leading-relaxed font-normal bg-indigo-950/40 p-4 rounded-xl border border-indigo-500/20">
                      {post.generatedText}
                    </p>
                  )}

                  {/* Render Visual Infographic if present */}
                  {post.infographic && (
                    <InfographicCanvas data={post.infographic} />
                  )}
                </div>

                {/* Character Count & Sales CTA Footer */}
                <div className="pt-3 border-t border-white/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 text-xs text-slate-400">
                  <span className="text-[11px] text-slate-400 font-mono">
                    {post.characterCount} / 280 characters
                  </span>
                  <span className="badge badge-emerald text-[10px]">
                    Sales CTA Included
                  </span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
