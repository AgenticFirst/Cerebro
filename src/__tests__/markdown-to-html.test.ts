import { describe, it, expect } from 'vitest';
import { renderMarkdownToHtml } from '../lib/markdown-to-html';

describe('renderMarkdownToHtml', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdownToHtml('')).toBe('');
  });

  it('renders headings as semantic h1/h2/h3 tags', () => {
    const html = renderMarkdownToHtml('# Title\n\n## Sub\n\n### Deeper');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Sub</h2>');
    expect(html).toContain('<h3>Deeper</h3>');
  });

  it('renders ordered and unordered lists', () => {
    const html = renderMarkdownToHtml('- a\n- b\n\n1. one\n2. two');
    expect(html).toMatch(/<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>[\s\S]*<\/ul>/);
    expect(html).toMatch(/<ol>[\s\S]*<li>one<\/li>[\s\S]*<li>two<\/li>[\s\S]*<\/ol>/);
  });

  it('renders fenced code blocks with <pre><code>', () => {
    const html = renderMarkdownToHtml("```ts\nconst x = 1;\n```");
    expect(html).toContain('<pre>');
    expect(html).toContain('<code');
    expect(html).toContain('const x = 1;');
  });

  it('renders inline code as <code>', () => {
    const html = renderMarkdownToHtml('Use `foo()` here');
    expect(html).toContain('<code>foo()</code>');
  });

  it('renders GFM tables', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>A</th>');
    expect(html).toContain('<td>1</td>');
  });

  it('renders bold and italic as semantic strong/em', () => {
    const html = renderMarkdownToHtml('**bold** and *italic*');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
  });

  it('renders links with href', () => {
    const html = renderMarkdownToHtml('[site](https://example.com)');
    expect(html).toContain('<a href="https://example.com">site</a>');
  });

  it('does not inject Tailwind / prose / syntax-highlighter classes', () => {
    const md = '# H\n\n```ts\n1;\n```\n\n- x';
    const html = renderMarkdownToHtml(md);
    expect(html).not.toMatch(/class="[^"]*prose/);
    expect(html).not.toMatch(/class="[^"]*text-/);
    expect(html).not.toMatch(/class="[^"]*token/);
  });
});
