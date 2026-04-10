import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';
import type {
  AgentMemoryDir,
  AgentMemoryFile,
  AgentMemoryFileContent,
} from '../types/memory';

interface MemoryContextValue {
  directories: AgentMemoryDir[];
  files: Record<string, AgentMemoryFile[]>; // keyed by slug
  isLoading: boolean;

  loadDirectories: () => Promise<void>;
  loadFiles: (slug: string) => Promise<void>;
  readFile: (slug: string, path: string) => Promise<AgentMemoryFileContent | null>;
  writeFile: (slug: string, path: string, content: string) => Promise<void>;
  deleteFile: (slug: string, path: string) => Promise<void>;
}

const MemoryContext = createContext<MemoryContextValue | null>(null);

interface ApiAgentMemoryDir {
  slug: string;
  file_count: number;
  last_modified: string | null;
}

interface ApiAgentMemoryFile {
  path: string;
  size: number;
  last_modified: string;
}

interface ApiAgentMemoryFileContent {
  path: string;
  content: string;
  last_modified: string;
}

function toDir(api: ApiAgentMemoryDir): AgentMemoryDir {
  return {
    slug: api.slug,
    fileCount: api.file_count,
    lastModified: api.last_modified,
  };
}

function toFile(api: ApiAgentMemoryFile): AgentMemoryFile {
  return {
    path: api.path,
    size: api.size,
    lastModified: api.last_modified,
  };
}

function toFileContent(api: ApiAgentMemoryFileContent): AgentMemoryFileContent {
  return {
    path: api.path,
    content: api.content,
    lastModified: api.last_modified,
  };
}

export function MemoryProvider({ children }: { children: ReactNode }) {
  const [directories, setDirectories] = useState<AgentMemoryDir[]>([]);
  const [files, setFiles] = useState<Record<string, AgentMemoryFile[]>>({});
  const [isLoading, setIsLoading] = useState(false);

  const loadDirectories = useCallback(async () => {
    setIsLoading(true);
    try {
      const res: BackendResponse<{ directories: ApiAgentMemoryDir[] }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: '/agent-memory',
        });
      if (res.ok) {
        setDirectories(res.data.directories.map(toDir));
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loadFiles = useCallback(async (slug: string) => {
    try {
      const res: BackendResponse<{ files: ApiAgentMemoryFile[] }> = await window.cerebro.invoke({
        method: 'GET',
        path: `/agent-memory/${encodeURIComponent(slug)}/files`,
      });
      if (res.ok) {
        setFiles((prev) => ({ ...prev, [slug]: res.data.files.map(toFile) }));
      }
    } catch {
      // ignore
    }
  }, []);

  const readFile = useCallback(
    async (slug: string, filePath: string): Promise<AgentMemoryFileContent | null> => {
      try {
        const res: BackendResponse<ApiAgentMemoryFileContent> = await window.cerebro.invoke({
          method: 'GET',
          path: `/agent-memory/${encodeURIComponent(slug)}/files/${filePath}`,
        });
        if (res.ok) {
          return toFileContent(res.data);
        }
      } catch {
        // ignore
      }
      return null;
    },
    [],
  );

  const writeFile = useCallback(
    async (slug: string, filePath: string, content: string) => {
      try {
        await window.cerebro.invoke({
          method: 'PUT',
          path: `/agent-memory/${encodeURIComponent(slug)}/files/${filePath}`,
          body: { content },
        });
        // Refresh listing for that slug + the directory summary
        await Promise.all([loadFiles(slug), loadDirectories()]);
      } catch (e) {
        console.error('Failed to write memory file:', e);
      }
    },
    [loadFiles, loadDirectories],
  );

  const deleteFile = useCallback(
    async (slug: string, filePath: string) => {
      try {
        await window.cerebro.invoke({
          method: 'DELETE',
          path: `/agent-memory/${encodeURIComponent(slug)}/files/${filePath}`,
        });
        await Promise.all([loadFiles(slug), loadDirectories()]);
      } catch (e) {
        console.error('Failed to delete memory file:', e);
      }
    },
    [loadFiles, loadDirectories],
  );

  return (
    <MemoryContext.Provider
      value={{
        directories,
        files,
        isLoading,
        loadDirectories,
        loadFiles,
        readFile,
        writeFile,
        deleteFile,
      }}
    >
      {children}
    </MemoryContext.Provider>
  );
}

export function useMemory(): MemoryContextValue {
  const ctx = useContext(MemoryContext);
  if (!ctx) throw new Error('useMemory must be used within MemoryProvider');
  return ctx;
}
