/**
 * Regression test for the "Slack step shows no editable config" half of the
 * routine-editor Slack bug.
 *
 * Even once a Slack step exists on the canvas, the step inspector
 * (StepConfigPanel) had no form for `send_slack_message` / `send_slack_file` /
 * `list_slack_channels`, so it fell through to the `StubParams` default which
 * just renders "<name> configuration coming soon." — the user could not set a
 * channel or message.
 *
 * This test renders the real StepConfigPanel for each Slack action (seeded with
 * the real getDefaultStepData) and asserts the dedicated editable form renders
 * — and that the "coming soon" stub does NOT. It would fail the moment the
 * ParamForm switch loses a Slack case or the catalog entry disappears.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { RoutineStepData } from '../../../../utils/dag-flow-mapping';

// react-i18next: identity translator (matches the repo's component-test pattern).
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// The Slack forms don't read these contexts, but the panel imports the hooks —
// stub them so the tree mounts without real providers.
vi.mock('../../../../context/ExpertContext', () => ({
  useExperts: () => ({ experts: [] }),
}));
vi.mock('../../../../context/FilesContext', () => ({
  useFiles: () => ({ buckets: [] }),
}));

import StepConfigPanel from '../StepConfigPanel';
import { getDefaultStepData } from '../../../../utils/step-defaults';

function makeNode(actionType: string): Node {
  const defaults = getDefaultStepData(actionType);
  const data: RoutineStepData = {
    stepId: 'n1',
    name: `New ${actionType}`,
    actionType,
    params: defaults.params,
    dependsOn: [],
    inputMappings: [],
    requiresApproval: defaults.requiresApproval,
    onError: defaults.onError,
  };
  return { id: 'n1', type: 'routineStep', position: { x: 0, y: 0 }, data } as Node;
}

function renderPanel(actionType: string) {
  render(
    <StepConfigPanel
      node={makeNode(actionType)}
      allNodes={[]}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('StepConfigPanel — Slack action forms', () => {
  it('never shows the "coming soon" stub for any Slack action', () => {
    for (const type of ['send_slack_message', 'send_slack_file', 'list_slack_channels']) {
      renderPanel(type);
      expect(
        screen.queryByText(/configuration coming soon/i),
        `${type} fell through to the StubParams placeholder`,
      ).toBeNull();
      cleanup();
    }
  });

  it('send_slack_message renders editable Channel + Message fields', () => {
    renderPanel('send_slack_message');
    // Resolved catalog label (proves the entry exists, not a raw-type fallback).
    expect(screen.getByText('Send Slack Message')).not.toBeNull();
    // The channel input and message textarea our SendSlackParams form renders.
    expect(screen.getByPlaceholderText(/C0123456789/)).not.toBeNull();
    expect(screen.getByPlaceholderText(/Daily summary/)).not.toBeNull();
  });

  it('send_slack_file renders Channel + file-source fields', () => {
    renderPanel('send_slack_file');
    expect(screen.getByText('Send Slack File')).not.toBeNull();
    expect(screen.getByPlaceholderText(/C0123456789/)).not.toBeNull();
    expect(screen.getByPlaceholderText(/absolute\/path\/to\/report\.pdf/)).not.toBeNull();
  });

  it('list_slack_channels renders the read-only info panel', () => {
    renderPanel('list_slack_channels');
    expect(screen.getByText('List Slack Channels')).not.toBeNull();
    expect(screen.getByText(/No configuration needed/i)).not.toBeNull();
  });
});
