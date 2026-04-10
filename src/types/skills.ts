export type SkillCategory =
  | 'engineering'
  | 'content'
  | 'operations'
  | 'support'
  | 'finance'
  | 'productivity'
  | 'fitness'
  | 'general';

export type SkillSource = 'builtin' | 'user' | 'marketplace';

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: SkillCategory;
  icon: string | null;
  instructions: string;
  toolRequirements: string[] | null;
  source: SkillSource;
  isDefault: boolean;
  author: string | null;
  version: string;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExpertSkillAssignment {
  id: string;
  expertId: string;
  skillId: string;
  isActive: boolean;
  assignedAt: string;
  skill: Skill;
}
