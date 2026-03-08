/**
 * condition action — if/else branching based on field evaluation.
 *
 * Evaluates a field from wiredInputs against a value using the specified
 * operator. Outputs a `branch` field ('true' or 'false') that downstream
 * steps can use via `branchCondition` on their inputMappings.
 */

import type { ActionDefinition, ActionInput, ActionOutput } from './types';
import { extractByPath } from '../utils';

type Operator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'matches_regex';

interface ConditionParams {
  field: string;
  operator: Operator;
  value?: string;
}

function evaluateCondition(fieldValue: unknown, operator: Operator, compareValue: string | undefined): boolean {
  const strValue = fieldValue != null
    ? (typeof fieldValue === 'object' ? JSON.stringify(fieldValue) : String(fieldValue))
    : '';

  switch (operator) {
    case 'equals':
      return strValue === (compareValue ?? '');

    case 'not_equals':
      return strValue !== (compareValue ?? '');

    case 'contains':
      return strValue.includes(compareValue ?? '');

    case 'not_contains':
      return !strValue.includes(compareValue ?? '');

    case 'greater_than': {
      const a = Number(fieldValue);
      const b = Number(compareValue);
      return !isNaN(a) && !isNaN(b) && a > b;
    }

    case 'less_than': {
      const a = Number(fieldValue);
      const b = Number(compareValue);
      return !isNaN(a) && !isNaN(b) && a < b;
    }

    case 'is_empty':
      return fieldValue == null || strValue === '' || (Array.isArray(fieldValue) && fieldValue.length === 0);

    case 'is_not_empty':
      return fieldValue != null && strValue !== '' && !(Array.isArray(fieldValue) && fieldValue.length === 0);

    case 'matches_regex':
      try {
        const pattern = compareValue ?? '';
        if (pattern.length > 200) return false;  // ReDoS protection
        return new RegExp(pattern).test(strValue);
      } catch {
        return false;
      }

    default:
      return false;
  }
}

export const conditionAction: ActionDefinition = {
  type: 'condition',
  name: 'Condition',
  description: 'If/else branching based on field evaluation.',

  inputSchema: {
    type: 'object',
    properties: {
      field: { type: 'string', description: 'Dot-path to the field to evaluate' },
      operator: { type: 'string', description: 'Comparison operator' },
      value: { type: 'string', description: 'Value to compare against' },
    },
    required: ['field', 'operator'],
  },

  outputSchema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean' },
      branch: { type: 'string', enum: ['true', 'false'] },
      evaluated_value: {},
    },
    required: ['passed', 'branch'],
  },

  execute: async (input: ActionInput): Promise<ActionOutput> => {
    const params = input.params as unknown as ConditionParams;
    const { field, operator, value } = params;

    if (!field) {
      throw new Error('Condition requires a field to evaluate');
    }

    const evaluatedValue = extractByPath(input.wiredInputs, field);
    const passed = evaluateCondition(evaluatedValue, operator, value);

    return {
      data: {
        passed,
        branch: passed ? 'true' : 'false',
        evaluated_value: evaluatedValue,
      },
      summary: `Condition ${field} ${operator} ${value ?? ''}: ${passed ? 'TRUE' : 'FALSE'}`,
    };
  },
};
