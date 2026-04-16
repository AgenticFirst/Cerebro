import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileText, FileCode, FileImage, File as FileIcon } from 'lucide-react';
import clsx from 'clsx';
import type { WorkspaceFileNode } from '../../../types/ipc';

interface FileTreeProps {
  nodes: WorkspaceFileNode[];
  selectedPath: string | null;
  onSelect: (node: WorkspaceFileNode) => void;
}

function iconForFile(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext)) return FileImage;
  if (['tsx', 'ts', 'jsx', 'js', 'mjs', 'cjs', 'py', 'go', 'rs', 'rb', 'java', 'c', 'cpp', 'h', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'sh'].includes(ext)) return FileCode;
  if (['md', 'txt', 'html'].includes(ext)) return FileText;
  return FileIcon;
}

function TreeNode({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: WorkspaceFileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (node: WorkspaceFileNode) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);

  if (node.type === 'dir') {
    const Icon = expanded ? FolderOpen : Folder;
    const Chevron = expanded ? ChevronDown : ChevronRight;
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 w-full px-2 py-1 rounded hover:bg-bg-hover transition-colors cursor-pointer text-left"
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <Chevron size={12} className="text-text-tertiary flex-shrink-0" />
          <Icon size={13} className="text-amber-400/70 flex-shrink-0" />
          <span className="text-xs text-text-secondary truncate">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const Icon = iconForFile(node.name);
  const isSelected = selectedPath === node.path;
  return (
    <button
      onClick={() => onSelect(node)}
      className={clsx(
        'flex items-center gap-1 w-full px-2 py-1 rounded transition-colors cursor-pointer text-left',
        isSelected ? 'bg-accent/15 text-accent' : 'hover:bg-bg-hover text-text-secondary',
      )}
      style={{ paddingLeft: `${8 + depth * 12 + 16}px` }}
    >
      <Icon size={13} className={clsx('flex-shrink-0', isSelected ? 'text-accent' : 'text-text-tertiary')} />
      <span className="text-xs truncate">{node.name}</span>
    </button>
  );
}

export default function FileTree({ nodes, selectedPath, onSelect }: FileTreeProps) {
  if (nodes.length === 0) {
    return null;
  }
  return (
    <div className="py-1">
      {nodes.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
