import type { KbTreeNode } from '../../../context/KnowledgeBaseContext';

/** Where a dragged page lands relative to the row it's dropped on. */
export type DropPosition = 'before' | 'after' | 'inside';

export interface DropTarget {
  parentId: string | null;
  sortOrder: number;
}

/** Depth-first lookup of a node by id. */
export function findNode(tree: KbTreeNode[], id: string): KbTreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = findNode(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** Children of `parentId` (or the roots when null), ordered by sortOrder. */
export function orderedSiblings(tree: KbTreeNode[], parentId: string | null): KbTreeNode[] {
  const list = parentId === null ? tree : (findNode(tree, parentId)?.children ?? []);
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** True when `nodeId` is a strict descendant of `ancestorId`. */
export function isDescendant(tree: KbTreeNode[], ancestorId: string, nodeId: string): boolean {
  const ancestor = findNode(tree, ancestorId);
  if (!ancestor) return false;
  const stack = [...ancestor.children];
  while (stack.length) {
    const n = stack.pop();
    if (!n) break;
    if (n.id === nodeId) return true;
    stack.push(...n.children);
  }
  return false;
}

/** A sort_order strictly between two neighbours: ends get ±1, gaps get the
 *  float midpoint (same idea as the Kanban board's position math). */
function between(prev: number | undefined, next: number | undefined): number {
  if (prev === undefined && next === undefined) return 1;
  if (prev === undefined) return (next as number) - 1;
  if (next === undefined) return prev + 1;
  return (prev + next) / 2;
}

/**
 * Resolve a drag (activeId) dropped on a row (overId) at a given position into
 * the new `{ parentId, sortOrder }`. Returns null for invalid/no-op moves:
 * dropping onto itself, or anywhere inside its own subtree.
 */
export function computeDropTarget(
  tree: KbTreeNode[],
  activeId: string | null,
  overId: string | null,
  position: DropPosition | null,
): DropTarget | null {
  if (!activeId || !overId || !position) return null;
  if (activeId === overId) return null;
  // Can't move a node into its own subtree.
  if (isDescendant(tree, activeId, overId)) return null;

  const over = findNode(tree, overId);
  const active = findNode(tree, activeId);
  if (!over || !active) return null;

  if (position === 'inside') {
    const siblings = orderedSiblings(tree, overId).filter((n) => n.id !== activeId);
    const last = siblings[siblings.length - 1];
    return { parentId: overId, sortOrder: last ? last.sortOrder + 1 : 1 };
  }

  // before / after a sibling of `over`
  const parentId = over.parentId;
  const siblings = orderedSiblings(tree, parentId).filter((n) => n.id !== activeId);
  const overIdx = siblings.findIndex((n) => n.id === overId);
  if (overIdx < 0) return null;

  const prev = position === 'before' ? siblings[overIdx - 1] : siblings[overIdx];
  const next = position === 'before' ? siblings[overIdx] : siblings[overIdx + 1];
  return { parentId, sortOrder: between(prev?.sortOrder, next?.sortOrder) };
}

/** Derive drop intent from the pointer's vertical position over the row rect:
 *  top quarter → before, bottom quarter → after, middle half → inside. */
export function positionAtPointer(
  pointerY: number,
  overTop: number,
  overHeight: number,
): DropPosition {
  if (overHeight <= 0) return 'inside';
  const rel = (pointerY - overTop) / overHeight;
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return 'inside';
}
