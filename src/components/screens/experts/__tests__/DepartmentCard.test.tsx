/**
 * Regression test for issue #64 — "Experts > Hierarchy: Team cards nest the
 * expand button inside the card button, firing a DOM error and breaking
 * keyboard/AT semantics".
 *
 * The department/team card rendered the chevron expand/collapse <button> as a
 * descendant of the outer team-select <button>. A <button> inside a <button>
 * is invalid HTML: React emits a `validateDOMNesting` console error and
 * assistive tech / keyboard tab order collapse the two controls into one.
 *
 * These tests pin the structural contract: the card header must expose two
 * SIBLING buttons (select-team and expand-toggle), never one nested in the
 * other, and clicking the chevron must toggle members without selecting the
 * team.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import DepartmentCard from '../DepartmentCard';
import type { Expert } from '../../../../context/ExpertContext';

function makeExpert(overrides: Partial<Expert> = {}): Expert {
  return {
    id: 'e1',
    slug: null,
    name: 'Expert One',
    domain: 'engineering',
    description: '',
    systemPrompt: null,
    type: 'expert',
    source: 'user',
    isEnabled: true,
    isPinned: false,
    isVerified: false,
    toolAccess: null,
    policies: null,
    requiredConnections: null,
    recommendedRoutines: null,
    teamMembers: null,
    strategy: null,
    coordinatorPrompt: null,
    avatarUrl: null,
    maxTurns: 10,
    tokenBudget: 1000,
    version: '1',
    lastActiveAt: null,
    createdAt: '2024-01-01',
    updatedAt: '2024-01-01',
    ...overrides,
  } as Expert;
}

function renderCard(overrides: Partial<React.ComponentProps<typeof DepartmentCard>> = {}) {
  const members = [makeExpert({ id: 'm1', name: 'Alice' }), makeExpert({ id: 'm2', name: 'Bob' })];
  const team = makeExpert({
    id: 't1',
    name: 'Engineering',
    type: 'team',
    teamMembers: [
      { expertId: 'm1', role: 'Lead', order: 0 },
      { expertId: 'm2', role: 'Dev', order: 1 },
    ],
  });
  const props = {
    team,
    members,
    isSelected: false,
    selectedMemberId: null,
    onSelectTeam: vi.fn(),
    onSelectMember: vi.fn(),
    onMemberContextMenu: vi.fn(),
    onTeamContextMenu: vi.fn(),
    ...overrides,
  };
  const result = render(<DepartmentCard {...props} />);
  return { ...result, props };
}

describe('DepartmentCard (issue #64)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => cleanup());

  it('does not nest a button inside another button', () => {
    const { container } = renderCard();
    // The core invalid-HTML bug: a <button> descendant of a <button>.
    expect(container.querySelectorAll('button button')).toHaveLength(0);
  });

  it('renders the team-select and expand controls as independent buttons', () => {
    const { container } = renderCard();
    const expandBtn = screen.getByRole('button', { name: /collapse|expand/i });
    expect(expandBtn).toBeInTheDocument();
    // The expand toggle must not be contained by any other button.
    expect(expandBtn.closest('button button')).toBeNull();
    let nested = false;
    container.querySelectorAll('button').forEach((b) => {
      if (b.querySelector('button')) nested = true;
    });
    expect(nested).toBe(false);
  });

  it('does not emit a validateDOMNesting console error on render', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderCard();
    const nestingError = errSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('validateDOMNesting')),
    );
    expect(nestingError).toBe(false);
  });

  it('toggling expand shows/hides members without selecting the team', () => {
    const onSelectTeam = vi.fn();
    renderCard({ onSelectTeam });
    // Expanded by default: members visible.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    const expandBtn = screen.getByRole('button', { name: /collapse/i });
    fireEvent.click(expandBtn);
    // Collapsed: members hidden, team not selected by the chevron click.
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(onSelectTeam).not.toHaveBeenCalled();
  });

  it('clicking the team header selects the team', () => {
    const onSelectTeam = vi.fn();
    renderCard({ onSelectTeam });
    fireEvent.click(screen.getByText('Engineering'));
    expect(onSelectTeam).toHaveBeenCalledTimes(1);
  });
});
