import type { WorkspaceFileNode } from '../types/ipc';

/** Flatten a workspace tree to a flat array of file nodes. */
export function flattenFiles(tree: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const out: WorkspaceFileNode[] = [];
  const walk = (nodes: WorkspaceFileNode[]) => {
    for (const node of nodes) {
      if (node.type === 'file') out.push(node);
      else if (node.children) walk(node.children as WorkspaceFileNode[]);
    }
  };
  walk(tree);
  return out;
}

export function countFiles(tree: WorkspaceFileNode[]): number {
  return flattenFiles(tree).length;
}
