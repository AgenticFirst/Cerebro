export interface AgentMemoryDir {
  slug: string;
  fileCount: number;
  lastModified: string | null;
}

export interface AgentMemoryFile {
  path: string;
  size: number;
  lastModified: string;
}

export interface AgentMemoryFileContent {
  path: string;
  content: string;
  lastModified: string;
}
