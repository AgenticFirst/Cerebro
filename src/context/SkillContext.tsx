import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { BackendResponse } from '../types/ipc';
import type { Skill, SkillCategory, SkillSource, ExpertSkillAssignment } from '../types/skills';

// ── API response types (snake_case) ────────────────────────────

interface ApiSkill {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  icon: string | null;
  instructions: string;
  tool_requirements: string[] | null;
  source: string;
  is_default: boolean;
  author: string | null;
  version: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface ApiExpertSkill {
  id: string;
  expert_id: string;
  skill_id: string;
  is_active: boolean;
  assigned_at: string;
  skill: ApiSkill;
}

function toSkill(api: ApiSkill): Skill {
  return {
    id: api.id,
    slug: api.slug,
    name: api.name,
    description: api.description,
    category: api.category as SkillCategory,
    icon: api.icon,
    instructions: api.instructions,
    toolRequirements: api.tool_requirements,
    source: api.source as SkillSource,
    isDefault: api.is_default,
    author: api.author,
    version: api.version,
    isEnabled: api.is_enabled,
    createdAt: api.created_at,
    updatedAt: api.updated_at,
  };
}

function toExpertSkillAssignment(api: ApiExpertSkill): ExpertSkillAssignment {
  return {
    id: api.id,
    expertId: api.expert_id,
    skillId: api.skill_id,
    isActive: api.is_active,
    assignedAt: api.assigned_at,
    skill: toSkill(api.skill),
  };
}

// ── Context ────────────────────────────────────────────────────

export interface ImportedSkillData {
  name: string;
  description: string;
  instructions: string;
  category: string;
  icon: string | null;
  author: string | null;
  version: string | null;
}

interface SkillContextValue {
  skills: Skill[];
  isLoading: boolean;
  loadSkills: () => Promise<void>;
  createSkill: (body: Record<string, unknown>) => Promise<Skill | null>;
  updateSkill: (id: string, fields: Record<string, unknown>) => Promise<Skill | null>;
  deleteSkill: (id: string) => Promise<void>;
  importSkill: (input: string) => Promise<ImportedSkillData>;
  getExpertSkills: (expertId: string) => Promise<ExpertSkillAssignment[]>;
  getSkillAssignments: (skillId: string) => Promise<ExpertSkillAssignment[]>;
  assignSkill: (expertId: string, skillId: string) => Promise<void>;
  unassignSkill: (expertId: string, skillId: string) => Promise<void>;
  toggleSkillActive: (expertId: string, skillId: string, isActive: boolean) => Promise<void>;
}

const SkillContext = createContext<SkillContextValue | null>(null);

export function SkillProvider({ children }: { children: ReactNode }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadSkills = useCallback(async () => {
    setIsLoading(true);
    try {
      const res: BackendResponse<{ skills: ApiSkill[]; total: number }> =
        await window.cerebro.invoke({
          method: 'GET',
          path: '/skills?limit=200',
        });
      if (res.ok) {
        setSkills(res.data.skills.map(toSkill));
      }
    } catch {
      // Backend not ready
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createSkill = useCallback(
    async (body: Record<string, unknown>): Promise<Skill | null> => {
      try {
        const res: BackendResponse<ApiSkill> = await window.cerebro.invoke({
          method: 'POST',
          path: '/skills',
          body,
        });
        if (res.ok) {
          const skill = toSkill(res.data);
          setSkills((prev) => [...prev, skill]);
          return skill;
        }
      } catch (e) {
        console.error('Failed to create skill:', e);
      }
      return null;
    },
    [],
  );

  const updateSkill = useCallback(
    async (id: string, fields: Record<string, unknown>): Promise<Skill | null> => {
      try {
        const res: BackendResponse<ApiSkill> = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/skills/${id}`,
          body: fields,
        });
        if (res.ok) {
          const updated = toSkill(res.data);
          setSkills((prev) => prev.map((s) => (s.id === id ? updated : s)));
          return updated;
        }
      } catch (e) {
        console.error('Failed to update skill:', e);
      }
      return null;
    },
    [],
  );

  const deleteSkill = useCallback(async (id: string) => {
    try {
      const res = await window.cerebro.invoke({
        method: 'DELETE',
        path: `/skills/${id}`,
      });
      if (res.ok || res.status === 204) {
        setSkills((prev) => prev.filter((s) => s.id !== id));
      }
    } catch (e) {
      console.error('Failed to delete skill:', e);
    }
  }, []);

  const importSkill = useCallback(
    async (input: string): Promise<ImportedSkillData> => {
      const res: BackendResponse<ImportedSkillData> = await window.cerebro.invoke({
        method: 'POST',
        path: '/skills/import',
        body: { input },
      });
      if (!res.ok) {
        throw new Error(
          (res.data as unknown as { detail?: string })?.detail ?? 'Import failed',
        );
      }
      return res.data;
    },
    [],
  );

  const getExpertSkills = useCallback(
    async (expertId: string): Promise<ExpertSkillAssignment[]> => {
      try {
        const res: BackendResponse<{ skills: ApiExpertSkill[]; total: number }> =
          await window.cerebro.invoke({
            method: 'GET',
            path: `/experts/${expertId}/skills`,
          });
        if (res.ok) {
          return res.data.skills.map(toExpertSkillAssignment);
        }
      } catch {
        // Backend not ready
      }
      return [];
    },
    [],
  );

  const getSkillAssignments = useCallback(
    async (skillId: string): Promise<ExpertSkillAssignment[]> => {
      try {
        const res: BackendResponse<{ skills: ApiExpertSkill[]; total: number }> =
          await window.cerebro.invoke({
            method: 'GET',
            path: `/skills/${skillId}/assignments`,
          });
        if (res.ok) {
          return res.data.skills.map(toExpertSkillAssignment);
        }
      } catch {
        // Backend not ready
      }
      return [];
    },
    [],
  );

  const syncExpert = (expertId: string) =>
    window.cerebro.installer.syncExpert(expertId).catch(console.error);

  const assignSkill = useCallback(
    async (expertId: string, skillId: string) => {
      try {
        const res = await window.cerebro.invoke({
          method: 'POST',
          path: `/experts/${expertId}/skills`,
          body: { skill_id: skillId },
        });
        if (res.ok) syncExpert(expertId);
      } catch (e) {
        console.error('Failed to assign skill:', e);
      }
    },
    [],
  );

  const unassignSkill = useCallback(
    async (expertId: string, skillId: string) => {
      try {
        const res = await window.cerebro.invoke({
          method: 'DELETE',
          path: `/experts/${expertId}/skills/${skillId}`,
        });
        if (res.ok || res.status === 204) syncExpert(expertId);
      } catch (e) {
        console.error('Failed to unassign skill:', e);
      }
    },
    [],
  );

  const toggleSkillActive = useCallback(
    async (expertId: string, skillId: string, isActive: boolean) => {
      try {
        const res = await window.cerebro.invoke({
          method: 'PATCH',
          path: `/experts/${expertId}/skills/${skillId}`,
          body: { is_active: isActive },
        });
        if (res.ok) syncExpert(expertId);
      } catch (e) {
        console.error('Failed to toggle skill:', e);
      }
    },
    [],
  );

  return (
    <SkillContext.Provider
      value={{
        skills,
        isLoading,
        loadSkills,
        createSkill,
        updateSkill,
        deleteSkill,
        importSkill,
        getExpertSkills,
        getSkillAssignments,
        assignSkill,
        unassignSkill,
        toggleSkillActive,
      }}
    >
      {children}
    </SkillContext.Provider>
  );
}

export function useSkills(): SkillContextValue {
  const ctx = useContext(SkillContext);
  if (!ctx) throw new Error('useSkills must be used within SkillProvider');
  return ctx;
}
