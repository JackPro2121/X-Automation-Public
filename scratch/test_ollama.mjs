const apiKey = 'a20dee1238ec433a955bfaff778181da.ridmP8Y1YNAKl_FFUtMxD_aM';

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
