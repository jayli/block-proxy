function send(res, statusCode, body, headers = {}) {
  const payload = Buffer.from(String(body), 'utf8');
  res.writeHead(statusCode, {
    'content-length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function indexHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Northstar Digital</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
      color: #1f2933;
      background: #f7f9fb;
      line-height: 1.55;
    }
    header {
      max-width: 1040px;
      margin: 0 auto;
      padding: 28px 24px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 24px;
    }
    .brand { font-weight: 700; font-size: 18px; letter-spacing: .02em; }
    nav { display: flex; gap: 18px; color: #52616f; font-size: 14px; }
    main { max-width: 1040px; margin: 0 auto; padding: 44px 24px 72px; }
    .hero {
      background: #ffffff;
      border: 1px solid #e3e8ef;
      border-radius: 6px;
      padding: 40px;
      box-shadow: 0 8px 24px rgba(31, 41, 51, .06);
    }
    h1 { margin: 0 0 16px; font-size: 38px; line-height: 1.18; font-weight: 700; }
    p { margin: 0; color: #52616f; max-width: 720px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 18px;
      margin-top: 28px;
    }
    .item {
      background: #ffffff;
      border: 1px solid #e3e8ef;
      border-radius: 6px;
      padding: 22px;
    }
    .item h2 { margin: 0 0 8px; font-size: 17px; }
    .item p { font-size: 14px; }
    .status {
      margin-top: 26px;
      padding: 14px 16px;
      border: 1px solid #d8e2dc;
      background: #f4faf6;
      color: #2f5d50;
      border-radius: 6px;
      font-size: 14px;
    }
    footer {
      max-width: 1040px;
      margin: 0 auto;
      padding: 26px 24px 40px;
      color: #7b8794;
      font-size: 13px;
    }
    @media (max-width: 640px) {
      header { align-items: flex-start; flex-direction: column; }
      nav { flex-wrap: wrap; }
      main { padding-top: 20px; }
      .hero { padding: 28px; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">Northstar Digital</div>
    <nav aria-label="Primary">
      <span>Insights</span>
      <span>Research</span>
      <span>Contact</span>
    </nav>
  </header>
  <main>
    <section class="hero">
      <h1>Practical research for reliable digital operations.</h1>
      <p>Northstar Digital publishes concise notes on infrastructure planning, service availability, and operational workflows for small teams.</p>
      <div class="grid">
        <article class="item">
          <h2>Operations</h2>
          <p>Guides for keeping internal services predictable, observable, and easy to maintain.</p>
        </article>
        <article class="item">
          <h2>Insights</h2>
          <p>Short field reports on deployment habits, capacity planning, and incident follow-up.</p>
        </article>
        <article class="item">
          <h2>Research</h2>
          <p>Independent notes on tools and patterns that reduce avoidable operational work.</p>
        </article>
      </div>
      <div class="status">Service status: online. Last content refresh completed successfully.</div>
    </section>
  </main>
  <footer>Copyright 2026 Northstar Digital. All rights reserved.</footer>
</body>
</html>`;
}

function handleDisguiseRequest(req, res) {
  const url = new URL(req.url || '/', 'https://localhost');
  if (url.pathname === '/' || url.pathname === '/index.html') {
    send(res, 200, indexHtml(), {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    return true;
  }

  send(res, 404, 'Not found', {
    'content-type': 'text/plain; charset=utf-8',
  });
  return false;
}

module.exports = {
  handleDisguiseRequest,
};
