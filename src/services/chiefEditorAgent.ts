import { GeneratedPost, BrandConfig } from '../types';
import { enforceThreadCharLimits, smartTrimTweet, threadWithinLimits, X_MAX_CHARS } from '../utils/tweetLimits';

export interface PostEvaluationResult {
  postId: string;
  score: number;
  passed: boolean;
  reasons: string[];
  suggestedImprovements: string;
  refinedPost?: GeneratedPost;
}

const TWEET_BREAK = '===TWEET_BREAK===';

/**
 * Autonomous AI Agent: Chief Content Officer (CCO)
 * Evaluates full THREAD quality — hook power, technical density,
 * natural flow between tweets, and CTA placement.
 * Uses MiMo v2.5-pro for evaluation; heuristic fallback if unavailable.
 */
export class ChiefEditorAgent {
  // SECURITY NOTE: this class used to call the MiMo LLM API directly from the
  // browser (via a VITE_-prefixed env var). VITE_-prefixed vars get inlined
  // into the built client bundle, so a paid API key would have been exposed
  // to anyone opening devtools on the deployed dashboard. The real CCO gate
  // (LLM-backed, with json_object mode) already runs safely server-side in
  // cron/seed_and_post.js. This client-side class now always uses the
  // heuristic evaluator — do not reintroduce a browser-side fetch to MiMo.

  /**
   * Evaluates a generated post (single tweet or thread) as a strict CCO
   */
  async evaluatePost(post: GeneratedPost, config: BrandConfig): Promise<PostEvaluationResult> {
    const isThread = post.generatedText?.includes(TWEET_BREAK);
    return this.heuristicEvaluate(post, config, isThread);
  }

  /**
   * Heuristic quality check — used when MiMo is unavailable
   */
  private heuristicEvaluate(
    post: GeneratedPost,
    config: BrandConfig,
    isThread: boolean
  ): PostEvaluationResult {
    const text = post.generatedText || '';
    const tweets = isThread
      ? text.split(TWEET_BREAK).map(t => t.trim()).filter(t => t.length > 5)
      : [text];

    const reasons: string[] = [];
    let score = 82;

    // Check hook quality
    const hookTweet = tweets[0] || '';
    const hookIsQuestion = hookTweet.trim().endsWith('?') && !hookTweet.includes('.');
    if (hookIsQuestion) {
      score -= 15;
      reasons.push('⚠ Hook ends with a question — weak pattern');
    } else {
      reasons.push('✓ Hook makes a direct claim');
    }

    // Check technical density across all tweets
    const fullText = tweets.join(' ');
    const hasRealModels = /deepseek|llama|qwen|claude|gemini|mistral|gpt-4|vllm|sglang|tensorrt/i.test(fullText);
    const hasNumbers = /\$[\d.]+|\d+ms|\d+%|\d+x|\d+\/1M/i.test(fullText);

    if (hasRealModels) { score += 8; reasons.push('✓ References real AI models'); }
    else { score -= 5; reasons.push('⚠ No specific model names found'); }

    if (hasNumbers) { score += 7; reasons.push('✓ Contains concrete numbers/metrics'); }
    else { score -= 5; reasons.push('⚠ Lacks specific benchmarks/costs'); }

    // Check thread structure
    if (isThread) {
      const allUnder280 = tweets.every(t => t.length <= 280);
      const hasCTA = tweets[tweets.length - 1]?.toLowerCase().includes('@m_jawad_yasin');

      if (allUnder280) { reasons.push(`✓ All ${tweets.length} tweets within 280 chars`); }
      else {
        score -= 20;
        const overLimit = tweets.filter(t => t.length > 280).length;
        reasons.push(`✗ ${overLimit} tweet(s) exceed 280 chars`);
      }

      if (hasCTA) { score += 5; reasons.push('✓ CTA points to @M_jawad_yasin'); }
      else { score -= 5; reasons.push('⚠ Missing @M_jawad_yasin CTA'); }
    } else {
      if (text.length > 280) {
        score -= 15;
        reasons.push(`✗ Single tweet exceeds 280 chars (${text.length})`);
      } else {
        reasons.push(`✓ Within 280 char limit (${text.length} chars)`);
      }
    }

    const finalScore = Math.max(0, Math.min(100, score));
    const passed = finalScore >= 80;

    const refinedPost = this.applyCharLimits({
      ...post,
      characterCount: text.length,
      status: passed ? 'approved' : 'draft'
    });

    return {
      postId: post.id,
      score: finalScore,
      passed,
      reasons,
      suggestedImprovements: finalScore < 80
        ? 'Add specific model names + benchmark numbers for higher impact'
        : 'Ready for publication',
      refinedPost
    };
  }

  private applyCharLimits(post: GeneratedPost): GeneratedPost {
    const TWEET_BREAK = '===TWEET_BREAK===';
    let generatedText = post.generatedText || '';
    if (generatedText.includes(TWEET_BREAK)) {
      const parts = generatedText.split(TWEET_BREAK).map((t) => t.trim()).filter((t) => t.length > 5);
      generatedText = enforceThreadCharLimits(parts).join(`\n${TWEET_BREAK}\n`);
    } else {
      generatedText = smartTrimTweet(generatedText);
    }
    return { ...post, generatedText, characterCount: generatedText.length };
  }
}

export const chiefEditorAgent = new ChiefEditorAgent();
