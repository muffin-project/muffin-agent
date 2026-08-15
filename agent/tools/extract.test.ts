import { describe, expect, it } from 'vitest';
import { extractMainContent, isHtmlContentType } from './extract.js';

describe('isHtmlContentType', () => {
  it('accepts text/html, with or without a charset suffix', () => {
    expect(isHtmlContentType('text/html')).toBe(true);
    expect(isHtmlContentType('text/html; charset=utf-8')).toBe(true);
  });

  it('accepts application/xhtml+xml', () => {
    expect(isHtmlContentType('application/xhtml+xml')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isHtmlContentType('TEXT/HTML')).toBe(true);
    expect(isHtmlContentType('Text/Html; Charset=UTF-8')).toBe(true);
  });

  it('rejects a JSON API response', () => {
    expect(isHtmlContentType('application/json')).toBe(false);
  });

  it('rejects a plain-text response', () => {
    expect(isHtmlContentType('text/plain')).toBe(false);
    expect(isHtmlContentType('text/plain; charset=utf-8')).toBe(false);
  });

  it('rejects a CSV response', () => {
    expect(isHtmlContentType('text/csv')).toBe(false);
  });

  it('rejects a near-miss mime type rather than substring-matching it', () => {
    expect(isHtmlContentType('text/html-fragment')).toBe(false);
    expect(isHtmlContentType('application/xhtml+xml+extra')).toBe(false);
  });

  it('rejects a missing or empty content-type', () => {
    expect(isHtmlContentType(null)).toBe(false);
    expect(isHtmlContentType('')).toBe(false);
  });
});

describe('extractMainContent', () => {
  const ARTICLE_HTML = `<!doctype html>
<html>
<head>
  <title>Sample article about muffins</title>
  <style>body { font-family: sans-serif; } .nav { display: flex; }</style>
  <script>window.dataLayer = window.dataLayer || []; function track(){ console.log('tracked'); }</script>
</head>
<body>
  <nav class="site-nav">
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  </nav>
  <div class="cookie-banner">This site uses cookies. <button>Accept</button></div>
  <main>
    <article>
      <h1>How to bake a proper muffin</h1>
      <p>A good muffin starts with cold butter and a light hand. Overmixing the batter
      develops gluten and produces a tough, chewy crumb instead of a tender one.</p>
      <p>Bake at 200 degrees Celsius for eighteen to twenty minutes, until a skewer
      inserted in the centre comes out clean.</p>
    </article>
  </main>
  <footer>
    <p>Copyright 2026 Muffin Bakery. All rights reserved.</p>
    <ul class="social"><li>Twitter</li><li>Instagram</li></ul>
  </footer>
  <script src="https://analytics.example.com/tracker.js"></script>
</body>
</html>`;

  it('keeps the article text and drops nav, cookie banner, footer, script and style', async () => {
    const content = await extractMainContent(ARTICLE_HTML, 'https://example.com/muffins');
    expect(content).not.toBeNull();
    expect(content).toContain('cold butter');
    expect(content).toContain('skewer');
    expect(content).not.toContain('Home');
    expect(content).not.toContain('cookies');
    expect(content).not.toContain('Twitter');
    expect(content).not.toContain('dataLayer');
    expect(content).not.toContain('font-family');
  });

  it('does not need the plausibility floor to accept a real, compact article behind heavy navigation', async () => {
    const navLinks = Array.from(
      { length: 60 },
      (_, i) => `<li><a href="/page${i}">Category ${i} — browse our catalogue section ${i}</a></li>`,
    ).join('\n');
    const html = `<!doctype html>
<html><head><title>A real short article</title></head><body>
<header><nav><ul>${navLinks}</ul></nav></header>
<main><article>
<h1>A real short article</h1>
<p>This paragraph is genuinely the content of the page, and it should survive extraction
even though the surrounding navigation is much larger in raw byte count than the article itself.</p>
<p>A second paragraph adds enough real prose that the extracted result comfortably clears
any reasonable plausibility floor a caller might apply to the ratio between input and output.</p>
</article></main>
<footer><p>footer boilerplate</p></footer>
</body></html>`;
    expect(html.length).toBeGreaterThan(2_000); // exercises the floor, not just the zero-content case
    const content = await extractMainContent(html, 'https://example.com/article');
    expect(content).not.toBeNull();
    expect(content).toContain('genuinely the content');
  });

  it('returns null rather than throwing on input with nothing an HTML parser can root a document in', async () => {
    await expect(extractMainContent('', 'https://example.com/')).resolves.toBeNull();
    await expect(extractMainContent('   \n  ', 'https://example.com/')).resolves.toBeNull();
    await expect(
      extractMainContent(JSON.stringify({ hello: 'world', items: [1, 2, 3] }), 'https://example.com/'),
    ).resolves.toBeNull();
    await expect(
      extractMainContent('just some plain text, no markup of any kind here at all.', 'https://example.com/'),
    ).resolves.toBeNull();
  });

  it('returns null when the document has no body content to extract', async () => {
    const content = await extractMainContent('<html>ciao</html>', 'https://example.com/');
    expect(content).toBeNull();
  });

  it('returns null when extraction is implausibly small next to a substantial input', async () => {
    const navLinks = Array.from(
      { length: 40 },
      (_, i) => `<li><a href="/page${i}">Category ${i} — browse our catalogue section ${i}</a></li>`,
    ).join('\n');
    const html = `<!doctype html>
<html><head><title>x</title></head><body>
<header><nav><ul>${navLinks}</ul></nav></header>
<main><p>Page not found.</p></main>
<footer><p>footer</p></footer>
</body></html>`;
    expect(html.length).toBeGreaterThan(2_000);
    const content = await extractMainContent(html, 'https://example.com/missing');
    expect(content).toBeNull();
  });
});
