import assert from 'node:assert';
import {
  ARCHETYPES,
  pickArchetype,
  buildPulsePrompt,
  cleanPulseText,
  upgradeModelNames,
  isPulseValid,
  OUTDATED_MODEL_REGEX,
  PIPELINE_NAME,
  V14_DAILY_MAX,
} from './conversational_pulse.js';

console.log('--- Testing v14 Conversational Pulse Pipeline ---');

// 1. Verify Archetypes Structure
assert(ARCHETYPES.length === 6, 'Should have exactly 6 archetypes');
const requiredArchetypeIds = ['reply_trap', 'founder_truth', 'tribal_contrast', 'trend_jacking', 'micro_dilemma', 'pick_one'];
for (const id of requiredArchetypeIds) {
  const found = ARCHETYPES.find((a) => a.id === id);
  assert(found, `Archetype ${id} must exist`);
  assert(found.fewShots.length >= 3, `Archetype ${id} must have at least 3 few-shots`);
  assert(found.topicAngles.length >= 3, `Archetype ${id} must have topic angles`);
}
console.log('✓ Archetypes structure verified (6 core archetypes loaded)');

// 2. Verify Archetype Rotation
const picked1 = pickArchetype(['reply_trap', 'founder_truth']);
assert(picked1 && picked1.id, 'Must pick an archetype');
assert(picked1.id !== 'founder_truth', 'Should avoid picking the most recent archetype');
console.log('✓ Archetype rotation logic verified');

// 3. Verify Prompt Builder
const testArchetype = ARCHETYPES[0];
const prompt = buildPulsePrompt(testArchetype);
assert(prompt.includes('Between 40 and 140 characters'), 'Prompt must enforce character limit');
assert(prompt.includes('NO DASHES'), 'Prompt must forbid dashes');
assert(prompt.includes('NO LINKS'), 'Prompt must forbid links');
assert(prompt.includes('BANNED WORDS'), 'Prompt must list banned words');
assert(prompt.includes('CURRENT 2026 FRONTIER AI ROSTER'), 'Prompt must include contemporary tech roster');
assert(prompt.includes('STRICTLY BANNED OUTDATED TECH'), 'Prompt must forbid outdated tech');
console.log('✓ Prompt builder rules, constraints, and contemporary tech roster verified');

// 4. Verify upgradeModelNames
assert(upgradeModelNames('Scaling GPT 4o on a rented H100') === 'Scaling GPT-6 Astra on a rented B200');
assert(upgradeModelNames('Self hosting Llama 3 on an RTX 4090') === 'Self hosting Muse Wonder on an RTX 5090');
assert(upgradeModelNames('Claude 3.7 vs Gemini 1.5 Pro') === 'Claude Opus 5.5 vs Gemini 4 Argon');
assert(upgradeModelNames('Self-hosting DeepSeek-R1 vs o3-mini') === 'Self-hosting DeepSeek V4.1 Flash vs GPT-6.1 Sol');
console.log('✓ upgradeModelNames accurately replaces stale tech with 2026 frontier tech');

// 5. Verify cleanPulseText (Dash removal, quote removal, whitespace, model upgrade)
const dirtyText = '<think>Let me formulate a good tweet</think>"Here is a thought — running GPT 4o on an H100 – really fast."';
const cleaned = cleanPulseText(dirtyText);
assert(!cleaned.includes('<think>'), 'Must strip reasoning tags');
assert(!cleaned.startsWith('"') && !cleaned.endsWith('"'), 'Must strip wrapping quotes');
assert(!cleaned.includes('—') && !cleaned.includes('–'), 'Must replace em-dashes and en-dashes');
assert(cleaned.includes(','), 'Dashes should become commas');
assert(cleaned.includes('GPT-6 Astra'), 'Must upgrade GPT 4o to GPT-6 Astra');
assert(cleaned.includes('B200'), 'Must upgrade H100 to B200');
console.log('✓ cleanPulseText correctly sanitizes reasoning, quotes, dashes, and upgrades models');

// 6. Verify isPulseValid Quality Gates
const validSample = 'If you had an 8x B200 cluster for 30 days,\n\nwhat model are you fine-tuning?';
assert(isPulseValid(validSample) === true, 'Valid sample must pass isPulseValid');

// 2026 Frontier model combinations pass
const modernSample1 = 'Claude Opus 5.5. GPT-6 Astra. Gemini 4 Argon. Muse Wonder.\n\nPick ONE for production.';
assert(isPulseValid(modernSample1) === true, '2026 Frontier models must pass');

const modernSample2 = 'GPT-6.1 Sol. DeepSeek V4.1 Flash. MiMo-V2.6-Pro. Grok 4.7.\n\nPick ONE for speed.';
assert(isPulseValid(modernSample2) === true, '2026 Fast frontier models must pass');

// Hard rejection of outdated models
assert(isPulseValid('Claude 3.7. Gemini 2.0. DeepSeek R1. GPT 4o.\n\nPick ONE.') === false, 'GPT 4o must be rejected');
assert(isPulseValid('Scaling GPT-4o or self hosting Llama 3 on an H100?') === false, 'Llama 3 and H100 must be rejected');
assert(isPulseValid('Why compare Claude 3.5 with Gemini 1.5 in production?') === false, 'Claude 3.5 and Gemini 1.5 must be rejected');
assert(isPulseValid('Running local inference on an RTX 4090 rig.') === false, 'RTX 4090 must be rejected');
assert(isPulseValid('Comparing Claude 3.7 with o3-mini.') === false, 'Claude 3.7 and o3-mini must be rejected');

// Short text (< 35 chars)
assert(isPulseValid('Too short') === false, 'Too short text must fail');

// Long text (> 175 chars)
const tooLong = 'A'.repeat(180);
assert(isPulseValid(tooLong) === false, 'Too long text must fail');

// Text with em-dash
assert(isPulseValid('This is great — really great in tech.') === false, 'Em-dash must be rejected');

// Text with external URL
assert(isPulseValid('Check out this link https://github.com/cool/repo') === false, 'URL must be rejected');

// Text with hashtag
assert(isPulseValid('Building AI agents is fun #AI #startup') === false, 'Hashtags must be rejected');

// Text with generic AI slop
assert(isPulseValid('This is a game-changer that will revolutionize developer workflows in today\'s fast-paced world.') === false, 'AI slop must be rejected');

console.log('✓ isPulseValid quality gates (length, dashes, URLs, hashtags, AI slop, outdated model rejection) verified');

// 7. Pipeline Config Constants
assert(PIPELINE_NAME === 'v14_conversational_pulse', 'Pipeline name must match contract');
assert(V14_DAILY_MAX >= 10, 'Daily max must be at least 10 slots');
console.log('✓ Pipeline constants and configuration verified');

console.log('✅ v14 conversational_pulse.test.js — all assertions passed\n');
