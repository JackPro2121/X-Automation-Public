import React, { useState, useRef, useEffect } from 'react';
import { MessageSquareQuote, Sparkles, Plus, CheckCircle2, TrendingUp, HelpCircle } from 'lucide-react';
import { AudienceGap, Creator } from '../../types';
import { aiEngine } from '../../services/aiEngine';

interface AudienceGapsTabProps {
  gaps: AudienceGap[];
  creators: Creator[];
  onAddGap: (gap: AudienceGap) => void;
  onConvertGapToPost: (gap: AudienceGap) => void;
}

export const AudienceGapsTab: React.FC<AudienceGapsTabProps> = ({
  gaps,
  creators,
  onAddGap,
  onConvertGapToPost
}) => {
  const [selectedCreator, setSelectedCreator] = useState(creators[0]?.handle || 'CarlWeische');
  const [isMining, setIsMining] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const timeoutRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup all timeouts on unmount
  useEffect(() => {
    return () => {
      timeoutRefs.current.forEach(t => clearTimeout(t));
    };
  }, []);

  const handleMineComments = () => {
    setIsMining(true);
    const t1 = setTimeout(() => {
      const newGap = aiEngine.generateAudienceGap(selectedCreator);
      onAddGap(newGap);
      setIsMining(false);
      setSuccessMsg(`Mined new audience gap from @${selectedCreator} replies!`);
      const t2 = setTimeout(() => setSuccessMsg(''), 4000);
      timeoutRefs.current.push(t2);
    }, 1200);
    timeoutRefs.current.push(t1);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="glass-panel p-6 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <MessageSquareQuote className="w-5 h-5 text-amber-400" />
            Audience Reply & Gap Miner
          </h2>
          <p className="text-sm text-slate-300 mt-1">
            Mines unanswered questions and objections hidden inside competitor tweet replies. Turn audience friction points into high-demand original content.
          </p>
        </div>
      </div>

      {/* Trigger Comment Miner Form */}
      <div className="glass-panel p-5 space-y-4">
        <h3 className="text-sm font-bold text-white uppercase tracking-wider text-slate-400">
          Mine Reply Gaps from Tracked Competitor
        </h3>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          <select
            value={selectedCreator}
            onChange={(e) => setSelectedCreator(e.target.value)}
            className="glass-input flex-1 w-full"
          >
            {creators.map((c) => (
              <option key={c.id} value={c.handle}>
                @{c.handle} — {c.name} ({c.category})
              </option>
            ))}
          </select>

          <button
            onClick={handleMineComments}
            disabled={isMining}
            className="btn-primary text-xs w-full sm:w-auto py-2.5 px-5 whitespace-nowrap"
          >
            {isMining ? (
              <>
                <Sparkles className="w-4 h-4 animate-spin" />
                Mining Reply Threads...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Mine Audience Gaps
              </>
            )}
          </button>
        </div>

        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            {successMsg}
          </div>
        )}
      </div>

      {/* Audience Gaps List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {gaps.map((gap) => (
          <div
            key={gap.id}
            className="glass-panel p-5 glass-panel-hover space-y-4 flex flex-col justify-between"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-white/10 pb-2.5">
                <span className="text-xs text-indigo-400 font-semibold">
                  Mined from @{gap.competitorHandle} replies
                </span>
                <span className="badge badge-amber text-[10px]">
                  Demand Score: {gap.demandScore}/100
                </span>
              </div>

              {/* User Reply Comment Quote */}
              <div className="p-3 rounded-xl bg-slate-900/90 border border-white/10 space-y-1.5">
                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                  <HelpCircle className="w-3 h-3 text-amber-400" />
                  Real Audience Objection / Reply
                </div>
                <p className="text-xs text-slate-200 italic">
                  "{gap.userReplyComment}"
                </p>
              </div>

              {/* Identified Pain Point */}
              <div className="space-y-1">
                <span className="text-[11px] text-slate-400 font-semibold uppercase">
                  Unanswered Gap:
                </span>
                <p className="text-xs text-white font-medium">
                  {gap.unansweredPainPoint}
                </p>
              </div>

              {/* Suggested Counter Hook */}
              <div className="p-3 rounded-xl bg-indigo-500/10 border border-indigo-500/20 space-y-1">
                <span className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1">
                  <Sparkles className="w-3 h-3 text-indigo-400" />
                  Generated Counter-Hook Concept
                </span>
                <p className="text-xs text-white font-semibold">
                  {gap.suggestedCounterHook}
                </p>
              </div>
            </div>

            <button
              onClick={() => onConvertGapToPost(gap)}
              className="btn-emerald text-xs w-full justify-center py-2"
            >
              <Plus className="w-4 h-4" />
              Convert Gap into Remixed Post
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
