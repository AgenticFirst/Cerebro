import { describe, it, expect } from 'vitest';
import { renderEmailTemplate, templateVariables } from '../templates';

describe('renderEmailTemplate', () => {
  it('substitutes provided variables', () => {
    const r = renderEmailTemplate('Hi {{first_name}}, welcome to {{company}}!', {
      first_name: 'Alice',
      company: 'Acme',
    });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Hi Alice, welcome to Acme!');
  });

  it('uses fallbacks when a value is missing or empty', () => {
    const r = renderEmailTemplate('Hi {{first_name|there}}!', { first_name: '' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Hi there!');
  });

  it('fails listing missing tokens without fallbacks', () => {
    const r = renderEmailTemplate('Hi {{first_name}}, re {{deal_name}}', {});
    expect(r.ok).toBe(false);
    expect(r.missing.sort()).toEqual(['deal_name', 'first_name']);
    // Tokens stay visible so the user sees what is unfilled.
    expect(r.text).toContain('{{first_name}}');
  });

  it('accepts numbers and tolerates whitespace in tokens', () => {
    const r = renderEmailTemplate('Total: {{ amount }}', { amount: 42 });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('Total: 42');
  });
});

describe('templateVariables', () => {
  it('collects unique variable names, ignoring fallbacks', () => {
    expect(templateVariables('{{a}} {{b|x}} {{a}} plain').sort()).toEqual(['a', 'b']);
  });
});
