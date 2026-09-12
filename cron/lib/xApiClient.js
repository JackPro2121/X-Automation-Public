/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   X (TWITTER) OFFICIAL API v2 CLIENT                            ║
 * ║   cron/lib/xApiClient.js                                         ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║   Direct OAuth 1.0a authenticated publishing for replies         ║
 * ║   Uses official X API v2 Free Tier (1,500 posts/month = )      ║
 * ║   Enforces daily (35) and monthly (1,400) safety governors       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import crypto from 'crypto';

export const DAILY_MAX_REPLIES = 35;
export const MONTHLY_MAX_REPLIES = 1400;

function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function getCredentials() {
  const consumerKey = process.env.X_CONSUMER_KEY || process.env.consumer_key || process.env.TWITTER_API_KEY || process.env.CONSUMER_KEY;
  const consumerSecret = process.env.X_CONSUMER_SECRET || process.env.Secret_key || process.env.TWITTER_API_SECRET || process.env.SECRET_KEY;
  const accessToken = process.env.X_ACCESS_TOKEN || process.env.Access_token || process.env.TWITTER_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET || process.env.Access_token_secret || process.env.TWITTER_ACCESS_SECRET || process.env.ACCESS_TOKEN_SECRET;

  if (!consumerKey || !consumerSecret || !accessToken || !accessTokenSecret) {
    return null;
  }
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

export function isXApiConfigured() {
  return !!getCredentials();
}

/**
 * Generate OAuth 1.0a HMAC-SHA1 Authorization Header.
 */
function buildOAuthHeader(method, url, extraParams = {}) {
  const creds = getCredentials();
  if (!creds) throw new Error('Missing X API credentials in environment.');

  const nonce = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
    ...extraParams
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys.map(k => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`).join('&');
  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(paramString)}`;
  const signingKey = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessTokenSecret)}`;

  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauthParams.oauth_signature = signature;

  const headerParams = [
    'oauth_consumer_key',
    'oauth_nonce',
    'oauth_signature',
    'oauth_signature_method',
    'oauth_timestamp',
    'oauth_token',
    'oauth_version'
  ].map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');

  return `OAuth ${headerParams}`;
}

/**
 * Verify authentication with X API.
 */
export async function verifyXApiAuth() {
 const url = 'https://api.twitter.com/2/users/me';
 try {
 const header = buildOAuthHeader('GET', url);
 const res = await fetch(url, {
 headers: {
 'Authorization': header,
 'User-Agent': 'X-Automation-Bot'
 },
 signal: AbortSignal.timeout(15000)
 });

 if (!res.ok) {
 const errText = await res.text();
 return { ok: false, status: res.status, error: errText };
 }

 const data = await res.json();
 return { ok: true, user: data?.data };
 } catch (err) {
 return { ok: false, error: err.message };
 }
}

/**
 * Post a direct reply to a tweet/comment using official X API v2.
 *
 * @param {string} inReplyToTweetId - The X ID of the tweet or comment being replied to
 * @param {string} text - The reply content (max 280 chars)
 * @returns {Promise<{success: boolean, tweetId?: string, error?: string}>}
 */
export async function postXReply(inReplyToTweetId, text) {
 if (!inReplyToTweetId || !text) {
 return { success: false, error: 'Missing inReplyToTweetId or reply text' };
 }

 const url = 'https://api.twitter.com/2/tweets';
 const cleanText = text.trim();

 try {
 const authHeader = buildOAuthHeader('POST', url);
 const payload = {
 text: cleanText,
 reply: {
 in_reply_to_tweet_id: inReplyToTweetId
 }
 };

 const res = await fetch(url, {
 method: 'POST',
 headers: {
 'Authorization': authHeader,
 'Content-Type': 'application/json',
 'User-Agent': 'X-Automation-Bot'
 },
 body: JSON.stringify(payload),
 signal: AbortSignal.timeout(20000)
 });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`  ❌ X API Error (${res.status}): ${errBody}`);
      return { success: false, status: res.status, error: errBody };
    }

    const data = await res.json();
    const newTweetId = data?.data?.id;
    return { success: true, tweetId: newTweetId };
  } catch (err) {
    console.error(`  ❌ X API Network/Fetch Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Post a direct standalone tweet to @M_jawad_yasin using official X API v2.
 *
 * @param {string} text - The tweet content
 * @returns {Promise<{success: boolean, tweetId?: string, error?: string}>}
 */
export async function postXTweet(text) {
  if (!text || !text.trim()) {
    return { success: false, error: 'Missing tweet text' };
  }

  const url = 'https://api.twitter.com/2/tweets';
  const cleanText = text.trim();

  try {
    const authHeader = buildOAuthHeader('POST', url);
    const payload = { text: cleanText };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'X-Automation-Bot'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error(`  ❌ X API Error (${res.status}): ${errBody}`);
      return { success: false, status: res.status, error: errBody };
    }

    const data = await res.json();
    const newTweetId = data?.data?.id;
    return { success: true, tweetId: newTweetId };
  } catch (err) {
    console.error(`  ❌ X API Network/Fetch Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
