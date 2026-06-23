/**
 * Tests for the task assignee picker — the surface that fixes "from a task you
 * always have to select one expert; there's no way to let Cerebro decide / use a
 * team."
 *
 * The picker must offer, in order: None, the builtin Cerebro orchestrator
 * (pinned, NOT duplicated in the experts list), the individual Experts group,
 * and the Teams group. Teams only appear when the experts context surfaces them
 * (it already hides teams when the beta flag is off), so "no teams in → no Teams
 * group" doubles as the flag-off case. Disabled experts are excluded.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';

// Identity translator — matches the repo's component-test convention.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Mutable expert list the mocked context returns; each test sets it.
let mockExperts: Array<Record<string, unknown>> = [];
vi.mock('../../../../context/ExpertContext', () => ({
  useExperts: () => ({ experts: mockExperts }),
}));

import AssigneeSelect from '../AssigneeSelect';

const CEREBRO = { id: 'cerebro', name: 'Cerebro', type: 'expert', isEnabled: true };
const CODER = { id: 'e1', name: 'Coder', type: 'expert', isEnabled: true };
const WRITER = { id: 'e2', name: 'Writer', type: 'expert', isEnabled: true };
const DISABLED = { id: 'e3', name: 'Retired', type: 'expert', isEnabled: false };
const TEAM = { id: 't1', name: 'Code Review Team', type: 'team', isEnabled: true };

function renderSelect(onChange = vi.fn(), value = '') {
  render(<AssigneeSelect value={value} onChange={onChange} noneLabel="Unassigned" />);
  return onChange;
}

afterEach(() => {
  cleanup();
  mockExperts = [];
});

describe('AssigneeSelect', () => {
  beforeEach(() => {
    mockExperts = [];
  });

  it('always offers the None option', () => {
    renderSelect();
    const none = screen.getByRole('option', { name: 'Unassigned' }) as HTMLOptionElement;
    expect(none.value).toBe('');
  });

  it('pins the Cerebro orchestrator and does NOT duplicate it in the Experts group', () => {
    mockExperts = [CODER, CEREBRO, WRITER];
    renderSelect();

    // Exactly one Cerebro option, and it carries the real expert id.
    const cerebroOpts = screen.getAllByRole('option', { name: 'Cerebro' }) as HTMLOptionElement[];
    expect(cerebroOpts).toHaveLength(1);
    expect(cerebroOpts[0].value).toBe('cerebro');

    // The Experts optgroup lists the other experts but not Cerebro.
    const expertsGroup = document.querySelector(
      'optgroup[label="tasks.expertGroupExperts"]',
    ) as HTMLOptGroupElement;
    expect(expertsGroup).not.toBeNull();
    const names = within(expertsGroup)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).toEqual(['Coder', 'Writer']);
    expect(names).not.toContain('Cerebro');
  });

  it('omits the Cerebro option when no Cerebro expert is present', () => {
    mockExperts = [CODER];
    renderSelect();
    expect(screen.queryByRole('option', { name: 'Cerebro' })).toBeNull();
  });

  it('shows the Teams group only when teams are present', () => {
    // Flag-off case: context surfaces no teams → no Teams group.
    mockExperts = [CODER];
    renderSelect();
    expect(document.querySelector('optgroup[label="tasks.expertGroupTeams"]')).toBeNull();
    cleanup();

    // Flag-on case: a team is surfaced → Teams group with that team.
    mockExperts = [CODER, TEAM];
    renderSelect();
    const teamsGroup = document.querySelector(
      'optgroup[label="tasks.expertGroupTeams"]',
    ) as HTMLOptGroupElement;
    expect(teamsGroup).not.toBeNull();
    const teamNames = within(teamsGroup)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(teamNames).toEqual(['Code Review Team']);
  });

  it('excludes disabled experts', () => {
    mockExperts = [CODER, DISABLED];
    renderSelect();
    expect(screen.queryByRole('option', { name: 'Retired' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Coder' })).toBeTruthy();
  });

  it('does not offer the old FK-broken "__auto__" sentinel', () => {
    mockExperts = [CEREBRO, CODER];
    renderSelect();
    const values = (screen.getAllByRole('option') as HTMLOptionElement[]).map((o) => o.value);
    expect(values).not.toContain('__auto__');
  });

  it('emits the selected id (Cerebro, a team, an expert, or none)', () => {
    mockExperts = [CEREBRO, CODER, TEAM];
    const onChange = renderSelect();
    const select = screen.getByRole('combobox') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'cerebro' } });
    expect(onChange).toHaveBeenLastCalledWith('cerebro');

    fireEvent.change(select, { target: { value: 't1' } });
    expect(onChange).toHaveBeenLastCalledWith('t1');

    fireEvent.change(select, { target: { value: 'e1' } });
    expect(onChange).toHaveBeenLastCalledWith('e1');

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });
});
