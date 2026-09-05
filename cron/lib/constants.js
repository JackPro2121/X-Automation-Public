/**
 * Shared constants for all cron pipelines.
 * Single source of truth — imported by seed_and_post.js, v4/*, and auto_poster.js.
 */

/** Separator used to split multi-tweet threads in generated_text column. */
export const TWEET_BREAK = '===TWEET_BREAK===';

/** X (Twitter) character limit per tweet. */
export const X_MAX_CHARS = 280;

/** Safe max leaving room for trim ellipsis. */
export const X_SAFE_MAX_CHARS = 277;

/** Buffer GraphQL API endpoint. */
export const BUFFER_API_URL = 'https://api.buffer.com';

/** Per-request timeout for Buffer API calls (ms). */
export const BUFFER_TIMEOUT_MS = 30000;

/** Max retry attempts in auto_poster before marking a post as permanently failed. */
export const MAX_RETRIES = 3;

/**
 * Dedup window in hours.
 * Reddit "hot" posts can stay visible for 2-3 days, so 72h prevents re-posting.
 * Previous value was 24h which was too short.
 */
export const DEDUP_WINDOW_HOURS = 72;

/** Single source of truth for the daily post ceiling.
 * Used by the shared Slack templates so every notification reports the same
 * target instead of hardcoded /40 or /50 values.
 */
export const DAILY_TARGET = 50;

/** GraphQL mutation for creating a single Buffer post. */
export const BUFFER_SINGLE_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post { id text status }
      }
      ... on MutationError {
        message
      }
    }
  }
`;
