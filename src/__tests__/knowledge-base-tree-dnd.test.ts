import { describe, it, expect } from 'vitest';
import type { KbTreeNode } from '../context/KnowledgeBaseContext';
import {
  findNode,
  orderedSiblings,
  isDescendant,
  computeDropTarget,
  positionAtPointer,
} from '../components/screens/knowledge-base/tree-dnd';

function node(
  id: string,
  sortOrder: number,
  parentId: string | null,
  children: KbTreeNode[] = [],
): KbTreeNode {
  return {
    id,
    parentId,
    title: id,
    icon: null,
    sortOrder,
    hasChildren: children.length > 0,
    children,
  };
}

//   a (1)
//     a1 (1)
//     a2 (2)
//   b (2)
function makeTree(): KbTreeNode[] {
  return [node('a', 1, null, [node('a1', 1, 'a'), node('a2', 2, 'a')]), node('b', 2, null)];
}

describe('tree-dnd helpers', () => {
  it('findNode locates nested nodes', () => {
    const tree = makeTree();
    expect(findNode(tree, 'a2')?.id).toBe('a2');
    expect(findNode(tree, 'nope')).toBeNull();
  });

  it('orderedSiblings sorts by sortOrder', () => {
    const tree = [node('a', 5, null), node('b', 1, null)];
    expect(orderedSiblings(tree, null).map((n) => n.id)).toEqual(['b', 'a']);
    expect(orderedSiblings(makeTree(), 'a').map((n) => n.id)).toEqual(['a1', 'a2']);
  });

  it('isDescendant is strict (excludes self)', () => {
    const tree = makeTree();
    expect(isDescendant(tree, 'a', 'a1')).toBe(true);
    expect(isDescendant(tree, 'a', 'a')).toBe(false);
    expect(isDescendant(tree, 'a', 'b')).toBe(false);
  });

  it('positionAtPointer classifies top/middle/bottom by pointer Y', () => {
    // over row: top=100, height=40 → boundaries at 110 (0.25) and 130 (0.75)
    expect(positionAtPointer(105, 100, 40)).toBe('before'); // rel 0.125
    expect(positionAtPointer(120, 100, 40)).toBe('inside'); // rel 0.5
    expect(positionAtPointer(135, 100, 40)).toBe('after'); // rel 0.875
  });
});

describe('computeDropTarget', () => {
  it('rejects invalid moves', () => {
    const tree = makeTree();
    expect(computeDropTarget(tree, 'a', 'a', 'inside')).toBeNull(); // onto self
    expect(computeDropTarget(tree, 'a', 'a1', 'inside')).toBeNull(); // into own descendant
    expect(computeDropTarget(tree, null, 'a', 'inside')).toBeNull();
    expect(computeDropTarget(tree, 'a', 'b', null)).toBeNull();
  });

  it('nests inside a target as last child', () => {
    const tree = makeTree();
    // drop b inside a → parent a, after a2 (sortOrder 2) → 3
    expect(computeDropTarget(tree, 'b', 'a', 'inside')).toEqual({ parentId: 'a', sortOrder: 3 });
  });

  it('nests inside an empty target → sortOrder 1', () => {
    const tree = makeTree();
    expect(computeDropTarget(tree, 'a1', 'b', 'inside')).toEqual({ parentId: 'b', sortOrder: 1 });
  });

  it('reorders before a sibling (midpoint)', () => {
    const tree = makeTree();
    // drop a2 before a1: parent a, siblings (excl a2) = [a1(1)]; before a1 → next=1, no prev → 0
    expect(computeDropTarget(tree, 'a2', 'a1', 'before')).toEqual({ parentId: 'a', sortOrder: 0 });
  });

  it('reorders after a sibling at end (+1)', () => {
    const tree = makeTree();
    // drop a1 after a2: parent a, siblings (excl a1) = [a2(2)]; after a2 → prev=2, no next → 3
    expect(computeDropTarget(tree, 'a1', 'a2', 'after')).toEqual({ parentId: 'a', sortOrder: 3 });
  });

  it('re-parents to root via before/after', () => {
    const tree = makeTree();
    // drop a1 after b at root: parent null, siblings (excl a1) = [a(1), b(2)]; after b → prev=2 → 3
    expect(computeDropTarget(tree, 'a1', 'b', 'after')).toEqual({ parentId: null, sortOrder: 3 });
  });

  it('inserts between two siblings as the midpoint', () => {
    // roots: x(1), y(2), z(3); drop z before y → between x(1) and y(2) → 1.5
    const tree = [node('x', 1, null), node('y', 2, null), node('z', 3, null)];
    expect(computeDropTarget(tree, 'z', 'y', 'before')).toEqual({ parentId: null, sortOrder: 1.5 });
  });
});
