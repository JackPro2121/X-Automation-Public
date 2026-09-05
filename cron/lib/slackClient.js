/**
 * Slack notification client for X-Automation pipelines.
 * Sends rich Block Kit messages with FULL post details, images, and key status.
 * Zero dependencies — uses native fetch (Node.js 18+).
 */

import { DAILY_TARGET } from './constants.js';

// ─── Core: Send Slack Message ─────────────────────────────────────────────────

export async function sendSlack(payload) {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channelId = process.env.SLACK_CHANNEL_ID;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  if (botToken && channelId) {
    try {
      const body = {
        channel: channelId,
        text: payload.text,
        ...(payload.blocks ? { blocks: payload.blocks } : {}),
      };

      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${botToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });

      const data = await res.json();
      if (!data.ok) {
        console.warn(`  ⚠ Slack API error: ${data.error}`);
        return { ok: false, error: data.error };
      }
      console.log('  ✓ Slack notification sent');
      return { ok: true };
    } catch (err) {
      console.warn(`  ⚠ Slack failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text();
        console.warn(`  ⚠ Slack webhook error ${res.status}: ${text}`);
        return { ok: false, error: text };
      }
      return { ok: true };
    } catch (err) {
      console.warn(`  ⚠ Slack failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  }

  return { ok: false, error: 'no_slack_config' };
}

// ─── Helper: Format Key Status ────────────────────────────────────────────────

function formatKeyStatus(keyStatus) {
  if (!keyStatus) return '';
  return keyStatus.keys.map(k => {
    const plan = k.planId ? ` | ${k.planId} $${k.monthlyCredits || 5}/mo` : '';
    const balance = k.balance ? ` | Bal: $${k.balance}` : '';
    const username = k.username && k.username !== 'error' && k.username !== 'unknown' ? ` (${k.username})` : '';
    if (k.exhausted) return `:red_circle: Key #${k.index}${username}: EXHAUSTED (${k.failures} fails)${plan}`;
    if (k.failures > 0) return `:large_yellow_circle: Key #${k.index}${username}: DEGRADED (${k.successes} ok, ${k.failures} fails)${plan}`;
    if (k.successes > 0) return `:large_green_circle: Key #${k.index}${username}: OK (${k.successes} uses)${plan}`;
    return `:white_circle: Key #${k.index}${username}: UNUSED${plan}`;
  }).join('\n');
}

// ─── Helper: Post Type Label ──────────────────────────────────────────────────

function getPostType(subreddit) {
  const freeTools = ['selfhosted', 'opensource', 'InternetIsBeautiful', 'github', 'SideProject', 'webdev', 'homelab', 'linux', 'commandline', 'coolgithubprojects', 'devops'];
  if (freeTools.includes(subreddit)) return ':hammer_and_wrench: FREE TOOLS';
  return ':robot_face: AI NEWS';
}

// ─── Helper: Caption Quality Audit ────────────────────────────────────────────
// Analyzes the generated tweet for: prompt leaks, hook type, emoji usage,
// and character budget. Renders as a compact Block Kit section so operators
// can spot bad captions from Slack without opening X.

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

function detectHookType(text) {
  if (!text) return 'Unknown';
  const t = text.toLowerCase();
  if (/^(⚡|🤖|🚀|🛠️|💡|✨|🔮|📈|💥|⚠️|📊|🏆|🎨|🖼️|🔴|🟣)\s*/.test(text)) {
    // Emoji-prefixed — fall through to content classification
  }
  if (/\bwill\b|\bby 20\d\d\b|\bin \d+ years\b|won't|not going to/.test(t)) return 'Prediction';
  if (/\d+%|\$\d|(\d+(\.\d+)?\s*(kb|mb|gb|tb|mi|mbps|kbps))|\d+(k|m|b)\b|upvotes|votes|\b\d+\b (chars|lines|times|hours|days|years)/i.test(t)) return 'Stat/Fact';
  if (t.includes('?') && /\b(what|why|how|who|did|does|is|are|can|should|ever)\b/.test(t)) return 'Question';
  if (/just|quietly|actually|still|nobody|everyone|the truth|the real|screw|breaks|crushed|terrify/i.test(t)) return 'Claim';
  if (/try it|thoughts|what do you|let me know|share|retweet|follow/.test(t)) return 'CTA-Led';
  return 'Unknown';
}

function detectEmojiUsage(text) {
  if (!text) return { count: 0, leading: false, list: [] };
  const matches = text.match(EMOJI_RE) || [];
  const leading = matches.length > 0 && text.indexOf(matches[0]) === 0;
  return { count: matches.length, leading, list: matches.slice(0, 3) };
}

function detectPromptLeaks(text) {
  if (!text) return [];
  const patterns = [
    /^hook\s*:/i, /^body\s*:/i, /^cta\s*:/i,
    /\((\d+)\s*chars\)/i, /a bit of a stretch/i,
    /fits the (prediction|style)/i, /^caption\s+structure/i,
    /tweet rules:/i, /hook style:/i, /no emojis/i, /no hashtags/i,
    /prediction style/i, /stop-scroll/i,
    /^explain the issue:/i, /^explain the problem:/i, /^explain:/i,
    /^describe the image:/i, /^describe:/i, /^analyze:/i, /^summarize:/i, /^rewrite:/i,
    /^selection\s*:/i, /is best\./i, / - good\./i, /the debate aspect/i,
    /feels more (cautionary|provocative)/i, /the prompt asks/i,
    // STRUCTURED-LABEL LEAKS (added Aug 10 — "5. Emoji:", "Intent:", "Content:", "The post is a screenshot")
    /^\d+\.\s*(emoji|content|hook|body|cta|intent|tone|style|rewrite|translate|title|char\s*(limit|count|s)?)\s*:/i,
    /^(intent|content|emoji|hook|body|cta|tone|style|char\s*(limit|count|s)?)\s*:/i,
    /^(the post is|this post (is|shows|contains)|this is a screenshot of|this is likely about|this image shows|the image shows)\b/i,
    /translate title if needed/i, /fits best/i, /this is likely about/i,
    /^(must start with|start the tweet|pick by intent|emoji rule|start with exactly one emoji|post to tweet about|visual breakdown)\b/i,
    /\b(must start with exactly one emoji|start the tweet with exactly one)\b/i,
  ];
  return patterns.filter(p => p.test(text)).map(p => p.source);
}

function captionQualityBlock(text, charCount) {
  if (!text) return null;
  const leaks = detectPromptLeaks(text);
  const hookType = detectHookType(text);
  const emoji = detectEmojiUsage(text);
  const chars = charCount || text.length;

  // Character budget: green ≤210, yellow 211-240, red >240
  const budget = chars <= 210 ? ':large_green_circle:' : chars <= 240 ? ':large_yellow_circle:' : ':red_circle:';
  const budgetNote = chars > 240 ? ' OVER LIMIT — truncated risk!' : chars <= 210 ? ' room to spare' : ' near limit';

  const hookEmoji = hookType === 'Prediction' ? ':crystal_ball:' : hookType === 'Stat/Fact' ? ':bar_chart:' : hookType === 'Question' ? ':question:' : hookType === 'Claim' ? ':zap:' : hookType === 'CTA-Led' ? ':point_right:' : ':grey_question:';
  const emojiNote = emoji.count === 0 ? ':x: none — flat start, add intent emoji' : emoji.count > 2 ? ':warning: too many' : emoji.leading ? `:white_check_mark: ${emoji.list.join(' ')} at start` : ':warning: not leading';

  const leakNote = leaks.length > 0
    ? `\n:rotating_light: *PROMPT LEAK DETECTED:* \`${leaks.join('`, `')}\` — caption is meta-text, NOT a real tweet!`
    : '';

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Caption QA:* ${budget} ${chars}/240 (${budgetNote})\n` +
        `${hookEmoji} Hook: *${hookType}* | :speech_balloon: Emoji: ${emojiNote}${leakNote}`
    }
  };
}

// ─── Template: Successful Post — FULL DETAILS ─────────────────────────────────

export function buildSuccessMessage({ pipeline, text, subreddit, upvotes, imageUrl, redditUrl, bufferId, elapsed, keyStatus, redditTitle, comments, charCount, llmKeyStatus, groqKeyStatus, modelUsed, todayCount }) {
  const isV6 = pipeline === 'v6';
  const isQuoteTweet = pipeline === 'quote_tweet';
  const isCatchup = pipeline === 'catchup';
  const isXSource = isV6 || isQuoteTweet; // Both scrape X accounts
  const postType = pipeline === 'v5' ? ':movie_camera: VIDEO/GIF' : isQuoteTweet ? ':speech_balloon: QUOTE TWEET' : isV6 ? ':bird: X CONTENT' : getPostType(subreddit);
  const pipelineEmoji = pipeline === 'v3' ? ':large_blue_circle:' : pipeline === 'v4' ? ':large_purple_circle:' : pipeline === 'v5' ? ':movie_camera:' : isV6 ? ':bird:' : isQuoteTweet ? ':speech_balloon:' : ':arrows_counterclockwise:';
  const charDisplay = charCount || (text ? text.length : 0);
  const modelLabel = modelUsed === 'groq-vision' ? ':eyes: Groq Vision (qwen3.6-27b)' 
    : modelUsed?.startsWith('groq-') ? `:brain: Groq (${modelUsed.replace('groq-', '')})`
    : modelUsed === 'groq-text' ? ':brain: Groq Text' 
    : modelUsed === 'groq-vision+openrouter' ? ':eyes: Groq Vision + :zap: OpenRouter'
    : modelUsed === 'openrouter' ? ':zap: OpenRouter (MiniMax-M3)' 
    : modelUsed === 'openrouter-thread' ? ':thread: OpenRouter Thread'
    : modelUsed === 'raw-title' ? ':memo: Raw Title (Fallback)'
    : `:robot_face: ${modelUsed || 'N/A'}`;
  const now = new Date();

  // v6 and quote_tweet use X handles, v3/v4 use subreddits
  const sourceLabel = isXSource ? `*@${subreddit}*` : `*r/${subreddit}*`;
  const sourceTitle = isXSource ? '*Original Tweet:*' : '*Reddit Post:*';
  const engagementLabel = isXSource ? ':heart: Likes' : ':arrow_up: Upvotes';
  const engagementValue = isXSource ? (upvotes || 0) : (upvotes || 0);
  const commentsLabel = isXSource ? ':speech_balloon: Replies' : ':speech_balloon: Comments';
  const sourceLink = isXSource ? `<${redditUrl}|@${subreddit}>` : `<${redditUrl}|r/${subreddit}>`;
  const imageAlt = isXSource ? `@${subreddit} post image` : `r/${subreddit} post image`;
  const imageTitle = isXSource ? `@${subreddit} — :heart:${engagementValue}` : `r/${subreddit} — :arrow_up:${engagementValue}`;

  const blocks = [
    // ── HEADER ──
    {
      type: 'header',
      text: { type: 'plain_text', text: `${pipelineEmoji} ${pipeline.toUpperCase()} — Post Published to X`, emoji: true }
    },

    // ── POST TYPE + SOURCE ──
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${postType} | ${sourceLabel}`
      }
    },

    // ── ORIGINAL TITLE ──
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${sourceTitle}\n${redditTitle || 'N/A'}`
      }
    },

    // ── TWEET TEXT (FULL) ──
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Generated Tweet (${charDisplay} chars):*\n\`\`\`${text}\`\`\``
      }
    },

    // ── CAPTION QUALITY AUDIT ──
    ...(captionQualityBlock(text, charDisplay) ? [captionQualityBlock(text, charDisplay)] : []),

    // ── STATS GRID ──
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Source:*\n${sourceLink}` },
        { type: 'mrkdwn', text: `${engagementLabel}:\n${engagementValue}` },
        { type: 'mrkdwn', text: `${commentsLabel}:\n${comments || 'N/A'}` },
        { type: 'mrkdwn', text: `*Characters:*\n${charDisplay}/280` },
        { type: 'mrkdwn', text: `*Buffer ID:*\n\`${bufferId || 'N/A'}\`` },
        { type: 'mrkdwn', text: `*Time:*\n:stopwatch: ${elapsed}s` },
        { type: 'mrkdwn', text: `*Image:*\n${imageUrl ? ':white_check_mark: Attached' : ':x: None'}` },
        { type: 'mrkdwn', text: `*Model:*\n${modelLabel}` },
        { type: 'mrkdwn', text: `*Daily Count:*\n:chart_with_upwards_trend: ${todayCount || '?'}/${DAILY_TARGET}` },
      ]
    },
  ];

  // ── IMAGE PREVIEW ──
  if (imageUrl) {
    blocks.push({
      type: 'image',
      image_url: imageUrl,
      alt_text: imageAlt,
      title: { type: 'plain_text', text: imageTitle }
    });
  }

  // ── DIVIDER ──
  blocks.push({ type: 'divider' });

  // ── APIFY KEY STATUS ──
  if (keyStatus) {
    const keyInfo = formatKeyStatus(keyStatus);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${keyStatus.provider || 'APIFY'} Keys:* ${keyStatus.available}/${keyStatus.total} available\n${keyInfo}`
      }
    });
  }

  // ── GROQ KEY STATUS ──
  if (groqKeyStatus) {
    const groqInfo = formatKeyStatus(groqKeyStatus);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Groq Keys:* ${groqKeyStatus.available}/${groqKeyStatus.total} available\n${groqInfo}`
      }
    });
  }

  // ── PRIMARY LLM KEY STATUS (OpenRouter; column name legacy "mimo") ──
  if (llmKeyStatus) {
    const llmInfo = formatKeyStatus(llmKeyStatus);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${llmKeyStatus.provider || "LLM"} Keys:* ${llmKeyStatus.available}/${llmKeyStatus.total} available\n${llmInfo}`
      }
    });
  }

  // ── FOOTER ──
  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:clock3: ${now.toISOString()} | ${now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT | X-Automation ${pipeline.toUpperCase()}` }
      ]
    }
  );

  const fallbackSource = isXSource ? `@${subreddit}` : `r/${subreddit}`;
  const fallbackEngagement = isXSource ? `❤️${upvotes || 0}` : `⬆${upvotes || 0}`;
  return {
    text: `✅ ${pipeline} published to X — ${fallbackSource} (${fallbackEngagement}) — ${text.substring(0, 80)}...`,
    blocks
  };
}

// ─── Template: Pipeline Failure — FULL DETAILS ────────────────────────────────

export function buildFailureMessage({ pipeline, step, error, keyStatus, llmKeyStatus, groqKeyStatus }) {
  const now = new Date();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:x: ${pipeline.toUpperCase()} — Pipeline Failed`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Pipeline:* ${pipeline}\n*Failed at:* ${step}\n*Error:*\n\`\`\`${(error || 'Unknown').substring(0, 300)}\`\`\``
      }
    },
    { type: 'divider' },
  ];

  if (keyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${keyStatus.provider || 'APIFY'} Keys:* ${keyStatus.available}/${keyStatus.total} available\n${formatKeyStatus(keyStatus)}`
      }
    });
  }

  if (llmKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${llmKeyStatus.provider || "LLM"} Keys:* ${llmKeyStatus.available}/${llmKeyStatus.total} available\n${formatKeyStatus(llmKeyStatus)}`
      }
    });
  }

  if (groqKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Groq Keys:* ${groqKeyStatus.available}/${groqKeyStatus.total} available\n${formatKeyStatus(groqKeyStatus)}`
      }
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:clock3: ${now.toISOString()} | ${now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT | :warning: Needs attention` }
      ]
    }
  );

  return {
    text: `❌ ${pipeline} pipeline failed at ${step}`,
    blocks
  };
}

// ─── Template: No Posts Found ─────────────────────────────────────────────────

export function buildNoPostsMessage({ pipeline, subredditsScanned, keyStatus, llmKeyStatus, groqKeyStatus }) {
  const now = new Date();
  const isXSource = pipeline === 'v6' || pipeline === 'quote_tweet';
  const sourceWord = isXSource ? 'accounts' : 'subreddits';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:warning: ${pipeline.toUpperCase()} — No Qualifying Posts`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Scanned *${subredditsScanned}* ${sourceWord} but found no qualifying posts.\n\nThis run was skipped — will retry next scheduled run.`
      }
    },
    { type: 'divider' },
  ];

  if (keyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${keyStatus.provider || 'APIFY'} Keys:* ${keyStatus.available}/${keyStatus.total} available\n${formatKeyStatus(keyStatus)}`
      }
    });
  }

  if (llmKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${llmKeyStatus.provider || "LLM"} Keys:* ${llmKeyStatus.available}/${llmKeyStatus.total} available\n${formatKeyStatus(llmKeyStatus)}`
      }
    });
  }

  if (groqKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Groq Keys:* ${groqKeyStatus.available}/${groqKeyStatus.total} available\n${formatKeyStatus(groqKeyStatus)}`
      }
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:clock3: ${now.toISOString()} | ${now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT | X-Automation ${pipeline.toUpperCase()}` }
      ]
    }
  );

  return {
    text: `⚠️ ${pipeline} — no qualifying posts found`,
    blocks
  };
}

// ─── Template: Partial Per-Post Failures ──────────────────────────────────────

export function buildPartialFailureMessage({ pipeline, successCount, failCount, queuedCount, keyStatus, llmKeyStatus, groqKeyStatus }) {
  const now = new Date();
  const failRate = (failCount / (successCount + failCount) * 100).toFixed(0);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:warning: ${pipeline.toUpperCase()} — ${failCount} Post(s) Failed`, emoji: true }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Results this run:*\n:white_check_mark: ${successCount} published | :x: ${failCount} failed${queuedCount ? ` | :hourglass_flowing_sand: ${queuedCount} queued` : ''}\n\n*Failure rate:* ${failRate}% — ${failRate >= 50 ? 'Most posts failed, check pipeline health.' : 'Some posts failed but pipeline continued.'}`
      }
    },
    { type: 'divider' },
  ];

  if (keyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${keyStatus.provider || 'APIFY'} Keys:* ${keyStatus.available}/${keyStatus.total} available\n${formatKeyStatus(keyStatus)}`
      }
    });
  }

  if (llmKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${llmKeyStatus.provider || "LLM"} Keys:* ${llmKeyStatus.available}/${llmKeyStatus.total} available\n${formatKeyStatus(llmKeyStatus)}`
      }
    });
  }

  if (groqKeyStatus) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Groq Keys:* ${groqKeyStatus.available}/${groqKeyStatus.total} available\n${formatKeyStatus(groqKeyStatus)}`
      }
    });
  }

  blocks.push(
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:clock3: ${now.toISOString()} | ${now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT | X-Automation ${pipeline.toUpperCase()}` }
      ]
    }
  );

  return {
    text: `⚠️ ${pipeline}: ${successCount} published, ${failCount} failed`,
    blocks
  };
}

// ─── Template: Daily Catch-Up Summary ─────────────────────────────────────────
export function buildCatchupSummary({ posted, todayTotal, gap, keyStatus }) {
  const now = new Date();

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:arrows_counterclockwise: DAILY CATCH-UP COMPLETE`, emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Posts Added:*\n${posted}` },
        { type: 'mrkdwn', text: `*Today Total:*\n${todayTotal}/${DAILY_TARGET}` },
        { type: 'mrkdwn', text: `*Gap Filled:*\n${gap > 0 ? gap : 'None needed'}` },
        { type: 'mrkdwn', text: `*Status:*\n${todayTotal >= DAILY_TARGET ? ':white_check_mark: Target met' : ':warning: Still short'}` },
      ]
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `:clock3: ${now.toISOString()} | ${now.toLocaleString('en-PK', { timeZone: 'Asia/Karachi' })} PKT` }
      ]
    }
  ];

  return {
    text: `🔄 Catch-up: ${posted} posts added, today total: ${todayTotal}/${DAILY_TARGET}`,
    blocks
  };
}

// ─── Template: Dry Run ────────────────────────────────────────────────────────

export function buildDryRunMessage({ pipeline, text, subreddit, upvotes }) {
  return {
    text: `🧪 ${pipeline} DRY RUN — r/${subreddit} (⬆${upvotes})`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `:test_tube: ${pipeline.toUpperCase()} — Dry Run`, emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Would post:*\n\`\`\`${text}\`\`\`\n\n*Source:* r/${subreddit} (⬆ ${upvotes})\n\nBuffer credentials missing — no post sent to X.`
        }
      },
      {
        type: 'context',
        elements: [
          { type: 'mrkdwn', text: `:clock3: ${new Date().toISOString()} | Dry run only` }
        ]
      }
    ]
  };
}
