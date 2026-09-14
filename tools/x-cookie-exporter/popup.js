document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge   = document.getElementById('statusBadge');
  const statusText    = document.getElementById('statusText');
  const authVal       = document.getElementById('authVal');
  const ct0Val        = document.getElementById('ct0Val');
  const copyJsonBtn   = document.getElementById('copyJsonBtn');
  const copyEnvBtn    = document.getElementById('copyEnvBtn');
  const toast         = document.getElementById('toast');

  let activeCookies = [];

  function showToast(msg) {
    toast.textContent = msg;
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 3500);
  }

  function mask(val) {
    if (!val || val.length < 8) return '••••••';
    return val.substring(0, 4) + '••••' + val.substring(val.length - 4);
  }

  try {
    // Search both x.com and twitter.com domains
    const [xCookies, twCookies] = await Promise.all([
      chrome.cookies.getAll({ domain: 'x.com' }),
      chrome.cookies.getAll({ domain: 'twitter.com' }),
    ]);

    const all = [...(xCookies || []), ...(twCookies || [])];
    const authCookie = all.find(c => c.name === 'auth_token');
    const ct0Cookie  = all.find(c => c.name === 'ct0');

    if (authCookie) {
      statusBadge.className = 'status-badge online';
      statusText.textContent = 'Active X Session Detected';

      authVal.textContent = mask(authCookie.value);
      ct0Val.textContent  = ct0Cookie ? mask(ct0Cookie.value) : '(optional)';

      // Prepare standard clean format consumable by Playwright
      activeCookies = [
        {
          name: 'auth_token',
          value: authCookie.value,
          domain: '.x.com',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ];

      if (ct0Cookie) {
        activeCookies.push({
          name: 'ct0',
          value: ct0Cookie.value,
          domain: '.x.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'Lax',
        });
      }

      copyJsonBtn.disabled = false;
      copyEnvBtn.disabled  = false;
    } else {
      statusBadge.className = 'status-badge offline';
      statusText.textContent = 'No X login session found';
      authVal.textContent = 'Not found';
      ct0Val.textContent  = 'Not found';
      authVal.style.color = '#f87171';
      ct0Val.style.color  = '#f87171';
    }
  } catch (err) {
    statusBadge.className = 'status-badge offline';
    statusText.textContent = 'Error: ' + err.message;
  }

  copyJsonBtn.addEventListener('click', async () => {
    if (activeCookies.length === 0) return;
    const jsonStr = JSON.stringify(activeCookies);
    await navigator.clipboard.writeText(jsonStr);
    showToast('✓ Copied JSON! Paste directly into GitHub Secret: X_COOKIES');
  });

  copyEnvBtn.addEventListener('click', async () => {
    if (activeCookies.length === 0) return;
    const jsonStr = JSON.stringify(activeCookies);
    const envLine = `X_COOKIES='${jsonStr}'`;
    await navigator.clipboard.writeText(envLine);
    showToast('✓ Copied .env line! Paste into your .env.local file');
  });
});
