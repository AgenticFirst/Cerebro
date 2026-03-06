import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';

// ── Types ──────────────────────────────────────────────────────

export type ExpertType = 'expert' | 'team';
export type ExpertSource = 'builtin' | 'user' | 'marketplace';

export interface ExpertModelConfig {
  source: 'local' | 'cloud';
  provider?: string | null;
  model_id: string;
  display_name: string;
}

export interface Expert {
  id: string;
  slug: string | null;
  name: string;
  domain: string | null;
  description: string;
  systemPrompt: string | null;
  type: ExpertType;
  source: ExpertSource;
  isEnabled: boolean;
  isPinned: boolean;
  toolAccess: string[] | null;
  policies: Record<string, unknown> | null;
  requiredConnections: string[] | null;
  recommendedRoutines: string[] | null;
  teamMembers: Array<{ expertId: string; role: string; order: number }> | null;
  avatarUrl: string | null;
  modelConfigData: ExpertModelConfig | null;
  maxTurns: number;
  tokenBudget: number;
  version: string;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateExpertInput {
  name: string;
  description: string;
  domain?: string;
  type?: ExpertType;
  systemPrompt?: string;
  toolAccess?: string[];
  source?: ExpertSource;
  teamMembers?: Array<{ expertId: string; role: string; order: number }>;
  strategy?: string;
  coordinatorPrompt?: string;
}

// ── API response types (snake_case) ────────────────────────────

interface ApiExpert {
  id: string;
  slug: string | null;
  name: string;
  domain: string | null;
  description: string;
  system_prompt: string | null;
  type: string;
  source: string;
  is_enabled: boolean;
  is_pinned: boolean;
  tool_access: string[] | null;
  policies: Record<string, unknown> | null;
  required_connections: string[] | null;
  recommended_routines: string[] | null;
  team_members: Array<{ expert_id: string; role: string; order: number }> | null;
  avatar_url: string | null;
  model_config_data: ExpertModelConfig | null;
  max_turns: number;
  token_budget: number;
  version: string;
  last_active_at: string | null;
  created_at: string;
  updated_at: string;
}

function toExpert(api: ApiExpert): Expert {
  return {
    id: api.id,
    slug: api.slug,
    name: api.name,
    domain: api.domain,
    description: api.description,
    systemPrompt: api.system_prompt,
    type: api.type as ExpertType,
    source: api.source as ExpertSource,
    isEnabled: api.is_enabled,
    isPinned: api.is_pinned,
    toolAccess: api.tool_access,
    policies: api.policies,
    requiredConnections: api.required_connections,
    recommendedRoutines: api.recommended_routines,
    teamMembers: api.team_members?.map((m) => ({
      expertId: m.expert_id,
      role: m.role,
      order: m.order,
    })) ?? null,
    avatarUrl: api.avatar_url,
    modelConfigData: api.model_config_data ?? null,
    maxTurns: api.max_turns ?? 10,
    tokenBudget: api.token_budget ?? 25000,
    version: api.version,
    lastActiveAt: api.last_active_at,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
  };
}

function toApiBody(input: CreateExpertInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.domain) body.domain = input.domain;
  if (input.type) body.type = input.type;
  if (input.systemPrompt) body.system_prompt = input.systemPrompt;
  if (input.toolAccess && input.toolAccess.length > 0) body.tool_access = input.toolAccess;
  if (input.source) body.source = input.source;
  if (input.teamMembers && input.teamMembers.length > 0) {
    body.team_members = input.teamMembers.map((m) => ({
      expert_id: m.expertId,
      role: m.role,
      order: m.order,
    }));
  }
  if (input.strategy) body.strategy = input.strategy;
  if (input.coordinatorPrompt) body.coordinator_prompt = input.coordinatorPrompt;
  return body;
}

// ── Context ────────────────────────────────────────────────────

interface ExpertContextValue {
  experts: Expert[];
  total: number;
  isLoading: boolean;
  activeCount: number;
  pinnedCount: number;
  loadExperts: () => Promise<void>;
  createExpert: (input: CreateExpertInput) => Promise<Expert | null>;
  updateExpert: (id: string, fields: Partial<ApiExpert>) => Promise<void>;
  deleteExpert: (id: string) => Promise<void>;
  toggleEnabled: (expert: Expert) => Promise<void>;
  togglePinned: (expert: Expert) => Promise<void>;
}

const ExpertContext = createContext<ExpertContextValue | null>(null);

export function ExpertProvider({ children }: { children: ReactNode }) {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const activeCount = useMemo(
    () => experts.filter((e) => e.isEnabled).length,
    [experts],
  );

  const pinnedCount = useMemo(
    () => experts.filter((e) => e.isPinned).length,
    [experts],
  );

  const loadExperts = useCallback(async () => {
    setIsLoading(true);
    try {
      const res: BackendResponse<{ experts: ApiExpert[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: '/experts?limit=200',
        });
      if (res.ok) {
        setExperts(res.data.experts.map(toExpert));
        setTotal(res.data.total);
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createExpert = useCallback(
    async (input: CreateExpertInput): Promise<Expert | null> => {
      try {
        const res: BackendResponse<ApiExpert> = await window.cerebro.invoke({
          method: 'POST',
          path: '/experts',
          body: toApiBody(input),
        });
        if (res.ok) {
          const expert = toExpert(res.data);
          setExperts((prev) => [...prev, expert]);
          setTotal((prev) => prev + 1);
          return expert;
        }
      } catch (e) {
        console.error('Failed to create expert:', e);
      }
      return null;
    },
    [],
  );

  const updateExpert = useCallback(
    async (id: string, fields: Partial<ApiExpert>) => {
      try {
        const res: BackendResponse<ApiExpert> = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/experts/${id}`,
          body: fields,
        });
        if (res.ok) {
          const updated = toExpert(res.data);
          setExperts((prev) => prev.map((e) => (e.id === id ? updated : e)));
        }
      } catch (e) {
        console.error('Failed to update expert:', e);
      }
    },
    [],
  );

  const deleteExpert = useCallback(async (id: string) => {
    try {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/experts/${id}`,
      });
      if (res.ok || res.status === 204) {
        setExperts((prev) => prev.filter((e) => e.id !== id));
        setTotal((prev) => Math.max(0, prev - 1));
      }
    } catch (e) {
      console.error('Failed to delete expert:', e);
    }
  }, []);

  const toggleEnabled = useCallback(
    async (expert: Expert) => {
      await updateExpert(expert.id, { is_enabled: !expert.isEnabled });
    },
    [updateExpert],
  );

  const togglePinned = useCallback(
    async (expert: Expert) => {
      await updateExpert(expert.id, { is_pinned: !expert.isPinned });
    },
    [updateExpert],
  );

  return (
    <ExpertContext.Provider
      value={{
        experts,
        total,
        isLoading,
        activeCount,
        pinnedCount,
        loadExperts,
        createExpert,
        updateExpert,
        deleteExpert,
        toggleEnabled,
        togglePinned,
      }}
    >
      {children}
    </ExpertContext.Provider>
  );
}

export function useExperts(): ExpertContextValue {
  const ctx = useContext(ExpertContext);
  if (!ctx) throw new Error('useExperts must be used within ExpertProvider');
  return ctx;
}
