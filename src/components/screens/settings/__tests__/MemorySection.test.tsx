/**
 * Regression test for issue #66 — "Settings > Memory lists agent directories by
 * raw hashed slugs with no search".
 *
 * The Memory section used to render one row per agent memory directory using the
 * on-disk slug (e.g. `principal-ios-engineer-rdww8x`), with a random hash suffix
 * that is pure noise, and offered no way to search across the list. This forced
 * the user to recall/parse cryptic slug strings rather than recognize a friendly
 * expert name — Nielsen heuristic #6 (recognition over recall).
 *
 * After the fix each row shows the friendly expert/team name resolved from the
 * slug, and a search field above the list filters by name (or slug).
 *
 * Every context the section depends on is mocked so the test never touches the
 * backend.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expertAgentName } from '../../../../shared/agent-name';
import type { AgentMemoryDir } from '../../../../types/memory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// Two experts with friendly display names. Their on-disk memory slug is derived
// the exact same way the installer/backend derive it, so the section can map a
// slug back to a name.
const EXPERTS = [
  { id: 'expert-ios-001', name: 'Principal iOS Engineer' },
  { id: 'team-build-002', name: 'App Build Team' },
];

const IOS_SLUG = expertAgentName(EXPERTS[0].id, EXPERTS[0].name);
const TEAM_SLUG = expertAgentName(EXPERTS[1].id, EXPERTS[1].name);

const DIRECTORIES: AgentMemoryDir[] = [
  { slug: IOS_SLUG, fileCount: 3, lastModified: null },
  { slug: TEAM_SLUG, fileCount: 1, lastModified: null },
];

const loadDirectories = vi.fn();
const loadFiles = vi.fn();

vi.mock('../../../../context/MemoryContext', () => ({
  useMemory: () => ({
    directories: DIRECTORIES,
    files: {},
    isLoading: false,
    loadDirectories,
    loadFiles,
    readFile: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../../../context/ExpertContext', () => ({
  useExperts: () => ({ experts: EXPERTS }),
}));

vi.mock('../../../../context/MarkdownDocumentContext', () => ({
  useMarkdownDocument: () => ({ open: vi.fn(), close: vi.fn() }),
}));

import MemorySection from '../MemorySection';

describe('MemorySection — issue #66 (recognition over recall)', () => {
  beforeEach(() => {
    loadDirectories.mockClear();
    loadFiles.mockClear();
    cleanup();
  });

  it('labels each agent row with its friendly name, not the raw hashed slug', () => {
    render(<MemorySection />);

    // Friendly names are visible…
    expect(screen.getByText('Principal iOS Engineer')).toBeInTheDocument();
    expect(screen.getByText('App Build Team')).toBeInTheDocument();

    // …and the raw cryptic slug is NOT used as the row's primary label.
    expect(screen.queryByText(IOS_SLUG)).not.toBeInTheDocument();
    expect(screen.queryByText(TEAM_SLUG)).not.toBeInTheDocument();
  });

  it('renders a search field that filters the agent list by name', () => {
    render(<MemorySection />);

    const search = screen.getByPlaceholderText('memory.searchPlaceholder');
    expect(search).toBeInTheDocument();

    // Both agents visible before filtering.
    expect(screen.getByText('Principal iOS Engineer')).toBeInTheDocument();
    expect(screen.getByText('App Build Team')).toBeInTheDocument();

    // Typing narrows the list to the matching agent.
    fireEvent.change(search, { target: { value: 'iOS' } });
    expect(screen.getByText('Principal iOS Engineer')).toBeInTheDocument();
    expect(screen.queryByText('App Build Team')).not.toBeInTheDocument();
  });
});
