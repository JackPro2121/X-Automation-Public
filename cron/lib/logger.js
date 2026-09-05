/**
 * Pipeline run logger.
 * Records every pipeline execution to Supabase `pipeline_runs` table.
 * Provides full visibility: what ran, what was posted, what failed, Apify key status.
 */

import { createClient } from '@supabase/supabase-js';
import { generateId } from './utils.js';

let supabase = null;

function getSupabase() {
  if (!supabase) {
    supabase = createClient(
      process.env.VITE_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

/**
 * Start a new pipeline run log entry.
 * Returns a run tracker object with methods to update and complete the run.
 *
 * @param {string} pipeline — 'v3', 'v4', or 'auto_poster'
 * @returns {PipelineRun}
 */
export function startRun(pipeline) {
  return new PipelineRun(pipeline);
}

class PipelineRun {
  constructor(pipeline) {
    this.id = generateId('run');
    this.pipeline = pipeline;
    this.startedAt = Date.now();
    this.data = {
      id: this.id,
      pipeline,
      status: 'running',
      started_at: new Date().toISOString(),
    };

    // A cancelled GitHub Actions job cannot call fail(). Reconcile only very old
    // entries for this pipeline before creating this run, so the dashboard never
    // presents cancelled jobs as actively running.
    this._closeStaleRuns().finally(() => this._save()).catch(() => {});
  }

  /**
   * Record which post was selected.
   */
  setPost({ title, url, upvotes, subreddit, generatedText, imageUrl }) {
    this.data.selected_post_title = title?.substring(0, 300) || null;
    this.data.selected_post_url = url || null;
    this.data.selected_post_upvotes = upvotes || null;
    this.data.subreddit = subreddit || null;
    this.data.generated_text = generatedText?.substring(0, 500) || null;
    this.data.image_url = imageUrl || null;
  }

  /**
   * Record Buffer API result.
   */
  setBufferResult(bufferPostId) {
    this.data.buffer_post_id = bufferPostId || null;
  }

  /**
   * Record Apify key manager status.
   */
  setApifyKeyStatus(keyStatus) {
    this.data.apify_keys_status = keyStatus || null;
  }

  /**
   * Record MiMo / OpenRouter LLM key manager status.
   */
  setMimoKeyStatus(keyStatus) {
    this.data.mimo_keys_status = keyStatus || null;
  }

  setLLMKeyStatus(keyStatus) {
    this.setMimoKeyStatus(keyStatus);
  }

  setLlmKeyStatus(keyStatus) {
    this.setMimoKeyStatus(keyStatus);
  }

  setllmKeystatus(keyStatus) {
    this.setMimoKeyStatus(keyStatus);
  }

  /**
   * Record Groq key manager status.
   */
  setGroqKeyStatus(keyStatus) {
    this.data.groq_keys_status = keyStatus || null;
  }

  /**
   * Record Slack notification sent.
   */
  setSlackSent(sent) {
    this.data.slack_sent = sent;
  }

  /**
   * Mark run as successful.
   */
  async success() {
    this.data.status = 'success';
    this.data.completed_at = new Date().toISOString();
    this.data.duration_seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    await this._save();
  }

  /**
   * Mark run as failed with error details.
   */
  async fail(error) {
    this.data.status = 'failed';
    this.data.error_message = (error?.message || error || 'Unknown error').substring(0, 500);
    this.data.completed_at = new Date().toISOString();
    this.data.duration_seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    await this._save();
  }

  /**
   * Mark run as no posts found (not a failure, just empty).
   */
  async noPosts(subredditsScanned) {
    this.data.status = 'no_posts';
    const sourceWord = ['v6', 'quote_tweet'].includes(this.pipeline) ? 'accounts' : 'subreddits';
    this.data.error_message = `Scanned ${subredditsScanned} ${sourceWord} — no qualifying posts found`;
    this.data.completed_at = new Date().toISOString();
    this.data.duration_seconds = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    await this._save();
  }

  /**
   * Save/update the run record in Supabase.
   * Retries without optional key-status columns if the live table is
   * missing them (e.g. groq_keys_status / mimo_keys_status not yet migrated),
   * so pipeline logging never fails on a schema drift.
   */
  async _save() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const attempt = async (payload) => {
      const { error } = await getSupabase()
        .from('pipeline_runs')
        .upsert(payload, { onConflict: 'id' });
      return error;
    };

    // A silently-dropped final save leaves the row stuck in 'running', which the
    // next run's stale-cleanup converts into a phantom "did not finish" failure.
    // Retry transient Supabase errors before giving up.
    try {
      let error = await attempt(this.data);

      for (let retry = 1; retry <= 2 && error; retry++) {
        console.warn(`  ⚠ Logger save failed (${error.message}) — retry ${retry}/2 in ${retry * 3}s`);
        await sleep(retry * 3000);
        error = await attempt(this.data);
      }

      if (error && /column.*does not exist|could not find the .* column/.test(error.message)) {
        const safe = { ...this.data };
        delete safe.groq_keys_status;
        delete safe.mimo_keys_status;
        error = await attempt(safe);
        if (error) {
          console.warn(`  ⚠ Logger save failed after column-drift fallback: ${error.message}`);
          return;
        }
      }

      if (error) {
        console.warn(`  ⚠ Logger save failed after retries: ${error.message}`);
      }
    } catch (err) {
      console.warn(`  ⚠ Logger error: ${err.message}`);
    }
  }

  async _closeStaleRuns() {
    try {
      const cutoff = new Date(Date.now() - 45 * 60 * 1000).toISOString();
      const { error } = await getSupabase()
        .from('pipeline_runs')
        .update({
          status: 'failed',
          error_message: 'Run did not finish; marked stale by the next pipeline start.',
          completed_at: new Date().toISOString(),
        })
        .eq('pipeline', this.pipeline)
        .eq('status', 'running')
        .lt('started_at', cutoff);

      if (error) console.warn(`  Logger stale-run cleanup failed: ${error.message}`);
    } catch (err) {
      console.warn(`  Logger stale-run cleanup error: ${err.message}`);
    }
  }
}
