/**
 * Regression tests for the "can't add a Slack message step from the routine
 * editor GUI" bug.
 *
 * Background: the engine fully supported `send_slack_message`,
 * `send_slack_file`, and `list_slack_channels` (chat-built routines used them),
 * but the routine editor's draggable action catalog (`ACTION_META`) only had a
 * dead `integration_slack` placeholder marked `isAvailable: false` whose key
 * didn't even match a real engine action type. So the GUI showed Slack as a
 * disabled "coming soon" item and nothing draggable mapped to the real action.
 *
 * These tests pin the contract that caused the bug: every Slack engine action
 * MUST have a catalog entry keyed by its exact engine `type`, marked available,
 * with default step data that seeds every required engine input and gates
 * (requiresApproval) in line with whether the action is read-only. A future
 * drift — renaming one side, flipping availability, dropping a required param,
 * or wrongly defaulting a write to no-approval — fails here.
 */

import { describe, it, expect } from 'vitest';
import {
  ACTION_META,
  getDefaultStepData,
  getActionsByCategory,
  type ActionCategoryId,
} from '../step-defaults';
import { createSendSlackMessageAction } from '../../engine/actions/send-slack-message';
import { createSendSlackFileAction } from '../../engine/actions/send-slack-file';
import { createListSlackChannelsAction } from '../../engine/actions/list-slack-channels';
import type { ActionDefinition } from '../../engine/actions/types';

// Build the real engine action definitions exactly as the engine registers
// them. We never call execute(), so a null channel is fine — we only read the
// static contract (type, name, inputSchema, readOnly).
const slackDefs: ActionDefinition[] = [
  createSendSlackMessageAction({ getChannel: () => null }),
  createSendSlackFileAction({ getChannel: () => null }),
  createListSlackChannelsAction({ getChannel: () => null }),
];

/** Mirror of the routine sidebar's "draggable" rule: available + not a trigger. */
function catalogIsDraggable(type: string): boolean {
  for (const { actions } of getActionsByCategory()) {
    const entry = actions.find(([key]) => key === type);
    if (entry) {
      const [, meta] = entry;
      return meta.isAvailable && meta.category !== 'triggers';
    }
  }
  return false;
}

describe('Slack actions exposed in the routine editor catalog', () => {
  it('removes the dead `integration_slack` placeholder', () => {
    // The old key didn't match any engine action type — its presence is the bug.
    expect(ACTION_META['integration_slack']).toBeUndefined();
  });

  for (const def of slackDefs) {
    describe(def.type, () => {
      it('has a catalog entry keyed by the exact engine action type', () => {
        expect(
          ACTION_META[def.type],
          `ACTION_META is missing an entry for engine action "${def.type}". ` +
            `The catalog key MUST equal the engine ActionDefinition.type or the ` +
            `dropped node maps to no executable action.`,
        ).toBeDefined();
      });

      it('catalog label matches the engine action name (no drift)', () => {
        expect(ACTION_META[def.type].name).toBe(def.name);
      });

      it('is available and draggable in the sidebar', () => {
        expect(ACTION_META[def.type].isAvailable).toBe(true);
        expect(catalogIsDraggable(def.type)).toBe(true);
      });

      it('lives in an editable category (integrations/output, never triggers)', () => {
        const allowed: ActionCategoryId[] = ['integrations', 'output'];
        expect(allowed).toContain(ACTION_META[def.type].category);
      });

      it('default step seeds every required engine input', () => {
        const required = (def.inputSchema?.required as string[] | undefined) ?? [];
        const { params } = getDefaultStepData(def.type);
        for (const key of required) {
          expect(
            Object.prototype.hasOwnProperty.call(params, key),
            `getDefaultStepData("${def.type}") is missing required input "${key}" — ` +
              `the step would fail validation the moment it runs.`,
          ).toBe(true);
        }
      });

      it('gates by approval iff the action writes (read-only ⇒ no gate)', () => {
        const { requiresApproval } = getDefaultStepData(def.type);
        if (def.readOnly) {
          expect(requiresApproval, `read-only "${def.type}" should not require approval`).toBe(
            false,
          );
        } else {
          expect(requiresApproval, `external send "${def.type}" should require approval`).toBe(
            true,
          );
        }
      });
    });
  }

  it('exposes exactly the three Slack actions (message, file, list)', () => {
    const slackKeys = Object.keys(ACTION_META).filter((k) => k.includes('slack'));
    expect(slackKeys.sort()).toEqual(
      ['list_slack_channels', 'send_slack_file', 'send_slack_message'].sort(),
    );
  });
});
