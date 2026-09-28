// A live Ollama Cloud key was hardcoded here and shipped to the PUBLIC repo on
// 2026-09-20 (commits 0c4a43a, d8183b4). Never hardcode a key here again — read
// it from the environment, which is already gitignored.
//
// If you need this probe, the key goes in .env.local as OLLAMA_API_KEY. A key
// that has been in a public repository must be treated as compromised and
// rotated, not merely deleted: git history retains it and public-repo secret
// scrapers index new commits within minutes.
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config(); // fallback to .env if present

const apiKey = process.env.OLLAMA_API_KEY;

if (!apiKey) {
  console.error('OLLAMA_API_KEY is not set. Add it to .env.local and re-run.');
  process.exit(1);
}

async function testOllama() {
  console.log('Testing Ollama API at https://ollama.com/api/chat with model gemma4:31b...');
  try {
    const res = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gemma4:31b',
        messages: [{ role: 'user', content: 'Say hello in one word.' }],
        stream: false,
      }),
    });

    console.log('HTTP Status:', res.status, res.statusText);
    const data = await res.json();
    console.log('Response body:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error calling Ollama:', err);
  }
}

testOllama();
