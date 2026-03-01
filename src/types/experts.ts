export type ExpertType = 'expert' | 'team';

export type ExpertSource = 'builtin' | 'user' | 'marketplace';

export interface TeamMember {
  expertId: string;
  role: string;
  order: number;
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
  teamMembers: TeamMember[] | null;
  avatarUrl: string | null;
  version: string | null;
  lastActiveAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExpertCreate {
  name: string;
  description: string;
  slug?: string;
  domain?: string;
  systemPrompt?: string;
  type?: ExpertType;
  source?: ExpertSource;
  isEnabled?: boolean;
  isPinned?: boolean;
  toolAccess?: string[];
  policies?: Record<string, unknown>;
  requiredConnections?: string[];
  recommendedRoutines?: string[];
  teamMembers?: TeamMember[];
  avatarUrl?: string;
  version?: string;
}

export interface ExpertUpdate {
  name?: string;
  description?: string;
  slug?: string;
  domain?: string;
  systemPrompt?: string;
  type?: ExpertType;
  source?: ExpertSource;
  isEnabled?: boolean;
  isPinned?: boolean;
  toolAccess?: string[];
  policies?: Record<string, unknown>;
  requiredConnections?: string[];
  recommendedRoutines?: string[];
  teamMembers?: TeamMember[];
  avatarUrl?: string;
  version?: string;
}

export interface ExpertListResponse {
  experts: Expert[];
  total: number;
}

export interface ExpertFilters {
  type?: ExpertType;
  source?: ExpertSource;
  isEnabled?: boolean;
  search?: string;
  offset?: number;
  limit?: number;
}
