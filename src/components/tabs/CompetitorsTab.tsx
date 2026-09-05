import React, { useState, useRef, useEffect } from 'react';
import { Users, Plus, Trash2, RefreshCw, CheckCircle2, ExternalLink, Search } from 'lucide-react';
import { Creator, ViralPost } from '../../types';
import { aiEngine } from '../../services/aiEngine';

interface CompetitorsTabProps {
  creators: Creator[];
  onAddCreator: (creator: Creator, scrapedPosts?: ViralPost[]) => void | Promise<void>;
  onDeleteCreator: (id: string) => void;
}

export const CompetitorsTab: React.FC<CompetitorsTabProps> = ({
  creators,
  onAddCreator,
  onDeleteCreator
}) => {
  const [newHandle, setNewHandle] = useState('');
  const [newCategory, setNewCategory] = useState('CRO & Marketing');
  const [isScraping, setIsScraping] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newHandle.trim()) return;

    setIsScraping(true);
    setSuccessMsg('');

    try {
      const { creator, posts } = await aiEngine.scrapeCreatorProfile(newHandle, newCategory);
      await onAddCreator(creator, posts);
      setNewHandle('');
      setSuccessMsg(`Successfully added @${creator.handle}! Saved ${posts.length} sample post(s) to viral library.`);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      console.error(err);
    } finally {
      setIsScraping(false);
    }
  };

  const filteredCreators = creators.filter(c => 
    c.handle.toLowerCase().includes(searchFilter.toLowerCase()) ||
    c.name.toLowerCase().includes(searchFilter.toLowerCase()) ||
    c.category.toLowerCase().includes(searchFilter.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-400" />
            Competitor & Creator Radar
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            Track top viral creators in your niche. The system automatically scrapes their highest performing hooks every week.
          </p>
        </div>
        <div className="text-xs text-slate-400 bg-slate-900/80 border border-white/10 px-3.5 py-2 rounded-xl">
          Tracking <strong className="text-white">{creators.length}</strong> creators across categories
        </div>
      </div>

      {/* Add Creator Form Card */}
      <form onSubmit={handleAddSubmit} className="glass-panel p-5 space-y-4">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider text-slate-400">
          Add New Competitor Profile
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-1">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Twitter / X Username or URL
            </label>
            <input
              type="text"
              placeholder="e.g. @CarlWeische or x.com/JoeHides"
              value={newHandle}
              onChange={(e) => setNewHandle(e.target.value)}
              required
              className="glass-input w-full"
            />
          </div>

          <div className="md:col-span-1">
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Niche / Category Tag
            </label>
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="glass-input w-full"
            >
              <option value="CRO & Marketing">CRO & Marketing</option>
              <option value="Paid Social & Ads">Paid Social & Ads</option>
              <option value="B2B SaaS Growth">B2B SaaS Growth</option>
              <option value="Copywriting & Content">Copywriting & Content</option>
              <option value="E-Commerce Scaling">E-Commerce Scaling</option>
            </select>
          </div>

          <div className="md:col-span-1 flex items-end">
            <button
              type="submit"
              disabled={isScraping}
              className="btn-emerald w-full justify-center py-2.5 text-xs"
            >
              {isScraping ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Scraping X Profile...
                </>
              ) : (
                <>
                  <Plus className="w-4 h-4" />
                  Add Creator to Radar
                </>
              )}
            </button>
          </div>
        </div>

        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2 animate-fadeIn">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            {successMsg}
          </div>
        )}
      </form>

      {/* Filter & Search Bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search tracked creators by handle, name, category..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="glass-input w-full pl-9"
          />
        </div>
      </div>

      {/* Creators Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredCreators.map((creator) => (
          <div
            key={creator.id}
            className="glass-panel p-5 glass-panel-hover flex flex-col justify-between space-y-4"
          >
            <div className="space-y-3">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <img
                    src={creator.avatar}
                    alt={creator.name}
                    className="w-12 h-12 rounded-full object-cover border-2 border-indigo-500/30"
                  />
                  <div>
                    <h4 className="text-base font-bold text-white flex items-center gap-1.5">
                      {creator.name}
                      {creator.verified && <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 fill-indigo-400/20" />}
                    </h4>
                    <a
                      href={`https://x.com/${creator.handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-400 hover:underline flex items-center gap-1"
                    >
                      @{creator.handle} <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
                <button
                  onClick={() => onDeleteCreator(creator.id)}
                  title="Delete creator from radar"
                  className="p-1.5 text-slate-500 hover:text-rose-400 hover:bg-white/5 rounded-lg transition-colors cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <p className="text-xs text-slate-300 line-clamp-2 leading-relaxed">
                {creator.bio}
              </p>

              <div className="flex items-center gap-2">
                <span className="badge badge-indigo text-[10px]">
                  {creator.category}
                </span>
                <span className="badge badge-emerald text-[10px]">
                  Top Score: {creator.topViralityScore}
                </span>
              </div>
            </div>

            {/* Metrics Footer */}
            <div className="pt-3 border-t border-white/10 flex items-center justify-between text-xs text-slate-400">
              <div>
                <strong className="text-white">{creator.followersCount.toLocaleString()}</strong> followers
              </div>
              <div className="text-[11px] text-slate-500">
                Scraped: {creator.lastScraped}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
