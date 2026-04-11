import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Lock,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useSandbox } from '../../../context/SandboxContext';
import type { LinkMode, LinkedProject } from '../../../sandbox/types';

const ABSOLUTE_FORBIDDEN_ZONES: readonly string[] = [
  '/System',
  '/usr',
  "Cerebro's own data directory",
];

function ModeBadge({ mode }: { mode: LinkMode }) {
  if (mode === 'write') {
    return (
      <span className="text-[10px] font-medium text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2 py-[3px] rounded-full">
        Read-Write
      </span>
    );
  }
  return (
    <span className="text-[10px] font-medium text-text-secondary bg-bg-elevated border border-border-subtle px-2 py-[3px] rounded-full">
      Read-Only
    </span>
  );
}

function LinkRow({
  link,
  onToggle,
  onRemove,
}: {
  link: LinkedProject;
  onToggle: (mode: LinkMode) => void;
  onRemove: () => void;
}) {
  const [promoting, setPromoting] = useState(false);
  const handleToggle = () => {
    if (link.mode === 'read') {
      setPromoting(true);
    } else {
      onToggle('read');
    }
  };

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-bg-surface border border-border-subtle rounded-lg">
      <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
        <FolderOpen size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text-primary truncate">{link.label}</span>
          <ModeBadge mode={link.mode} />
        </div>
        <div className="text-xs text-text-tertiary font-mono truncate mt-0.5">{link.path}</div>

        {promoting && (
          <div className="mt-2 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200">
            <div className="flex items-center gap-1.5 mb-1.5 font-medium">
              <AlertTriangle size={12} />
              Allow Cerebro to write into this directory?
            </div>
            <div className="text-amber-200/70 mb-2">
              Agents will be able to create, modify, and delete files under{' '}
              <span className="font-mono">{link.path}</span>.
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  onToggle('write');
                  setPromoting(false);
                }}
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-amber-500/25 text-amber-100 hover:bg-amber-500/35 cursor-pointer"
              >
                Yes, allow writes
              </button>
              <button
                onClick={() => setPromoting(false)}
                className="px-2.5 py-1 rounded text-[11px] text-text-secondary hover:text-text-primary cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={handleToggle}
          className="px-2 py-1 rounded-md text-[11px] text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer"
          title={link.mode === 'read' ? 'Promote to Read-Write' : 'Revert to Read-Only'}
        >
          {link.mode === 'read' ? 'Allow writes' : 'Make read-only'}
        </button>
        <button
          onClick={onRemove}
          className="p-1.5 rounded-md text-text-tertiary hover:text-red-400 hover:bg-white/[0.04] transition-colors cursor-pointer"
          title="Unlink project"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

export default function SandboxSection() {
  const {
    config,
    isLoading,
    setEnabled,
    pickAndLinkProject,
    setLinkMode,
    removeLink,
    revealWorkspace,
    fetchProfile,
    lastError,
    clearError,
  } = useSandbox();

  const [profileOpen, setProfileOpen] = useState(false);
  const [profileText, setProfileText] = useState<string>('');
  const [confirmDisable, setConfirmDisable] = useState(false);

  useEffect(() => {
    if (!profileOpen) return;
    let cancelled = false;
    fetchProfile().then((text) => {
      if (!cancelled) setProfileText(text);
    });
    return () => { cancelled = true; };
  }, [profileOpen, config?.linked_projects, config?.workspace_path, config?.enabled, fetchProfile]);

  const enabled = config?.enabled ?? false;
  const platformSupported = config?.platform_supported ?? false;
  const activeEnforcement = enabled && platformSupported;

  const statusPill = useMemo(() => {
    if (!config) return null;
    if (activeEnforcement) {
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 rounded-full">
          <ShieldCheck size={12} /> Active
        </span>
      );
    }
    if (enabled && !platformSupported) {
      return (
        <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-300 bg-amber-500/15 border border-amber-500/30 px-2.5 py-1 rounded-full">
          <AlertTriangle size={12} /> Unsupported platform
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-text-tertiary bg-bg-elevated border border-border-subtle px-2.5 py-1 rounded-full">
        <ShieldOff size={12} /> Disabled
      </span>
    );
  }, [config, enabled, platformSupported, activeEnforcement]);

  const handleToggle = () => {
    if (!config) return;
    if (enabled) {
      setConfirmDisable(true);
    } else {
      setEnabled(true);
    }
  };

  if (isLoading || !config) {
    return (
      <div className="text-sm text-text-tertiary">Loading sandbox settings…</div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium text-text-primary">Sandbox</h2>
        <p className="text-sm text-text-secondary mt-1 leading-relaxed">
          Restrict what Cerebro's agents can read and write on your Mac. The sandbox is a
          macOS Seatbelt profile wrapped around the Claude Code subprocess — denied operations
          fail with a permission error instead of touching your files.
        </p>
      </div>

      {/* Enable card */}
      <div className="flex items-center gap-4 px-4 py-3.5 bg-bg-surface border border-border-subtle rounded-lg">
        <div
          className={clsx(
            'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
            activeEnforcement ? 'bg-accent/15 text-accent' : 'bg-white/[0.04] text-text-tertiary',
          )}
        >
          <Shield size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">Enable sandbox</span>
            {statusPill}
            {!platformSupported && (
              <span className="text-[10px] text-text-tertiary bg-bg-elevated border border-border-subtle px-2 py-0.5 rounded-full">
                macOS only (v1)
              </span>
            )}
          </div>
          <div className="text-xs text-text-secondary mt-0.5">
            {activeEnforcement
              ? 'Agents can only touch the workspace and linked projects.'
              : 'Agents have unrestricted access to your files.'}
          </div>
        </div>
        <button
          onClick={handleToggle}
          className={clsx(
            'relative w-10 h-6 rounded-full transition-colors cursor-pointer flex-shrink-0',
            enabled ? 'bg-accent' : 'bg-white/[0.08]',
          )}
          aria-label={enabled ? 'Disable sandbox' : 'Enable sandbox'}
        >
          <span
            className={clsx(
              'absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform',
              enabled ? 'translate-x-[18px]' : 'translate-x-0.5',
            )}
          />
        </button>
      </div>

      {confirmDisable && (
        <div className="px-4 py-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-sm text-amber-200">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="font-medium">Disable sandbox?</div>
              <div className="text-xs text-amber-200/80 mt-1">
                Every agent run after this point will have full access to your home directory and
                every file you can read or write.
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => {
                    setEnabled(false);
                    setConfirmDisable(false);
                  }}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/25 text-amber-100 hover:bg-amber-500/35 cursor-pointer"
                >
                  Yes, disable
                </button>
                <button
                  onClick={() => setConfirmDisable(false)}
                  className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary cursor-pointer"
                >
                  Keep enabled
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {lastError && (
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-500/30 bg-red-500/10 text-xs text-red-300">
          <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{lastError}</span>
          <button
            onClick={clearError}
            className="text-red-300/60 hover:text-red-300 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Workspace card */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2">
          Workspace
        </div>
        <div className="flex items-center gap-3 px-4 py-3.5 bg-bg-surface border border-border-subtle rounded-lg">
          <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
            <FolderOpen size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">Cerebro workspace</div>
            <div className="text-xs text-text-tertiary font-mono truncate mt-0.5">
              {config.workspace_path}
            </div>
          </div>
          <button
            onClick={revealWorkspace}
            className="px-2.5 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.04] transition-colors cursor-pointer"
          >
            Open in Finder
          </button>
        </div>
        <p className="text-[11px] text-text-tertiary mt-2 leading-relaxed">
          Always read-write. Agents default to this directory when they just need a scratch
          space. Your existing projects live elsewhere — link them below.
        </p>
      </div>

      {/* Linked projects card */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
            Linked projects
          </div>
          <button
            onClick={() => pickAndLinkProject('read')}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent/15 text-accent hover:bg-accent/25 transition-colors cursor-pointer"
          >
            <FolderPlus size={12} />
            Link Project
          </button>
        </div>
        {config.linked_projects.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-text-tertiary bg-bg-surface border border-dashed border-border-subtle rounded-lg">
            No projects linked yet. Click <span className="text-text-secondary">Link Project</span>{' '}
            to grant Cerebro access to a specific directory — for example{' '}
            <span className="font-mono text-text-secondary">~/Desktop/projects/my-repo</span>.
          </div>
        ) : (
          <div className="space-y-2">
            {config.linked_projects.map((link) => (
              <LinkRow
                key={link.id}
                link={link}
                onToggle={(mode) => setLinkMode(link.id, mode)}
                onRemove={() => removeLink(link.id)}
              />
            ))}
          </div>
        )}
        <p className="text-[11px] text-text-tertiary mt-2 leading-relaxed">
          New links default to <span className="text-text-secondary">Read-Only</span>. Promote to
          Read-Write per project when you want agents to actually make changes.
        </p>
      </div>

      {/* Forbidden zones */}
      <div className="px-4 py-3.5 rounded-lg border border-border-subtle bg-bg-surface">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-2">
          <Lock size={11} /> Always blocked
        </div>
        <div className="flex flex-wrap gap-1.5">
          {config.forbidden_home_subpaths.map((sub) => (
            <span
              key={sub}
              className="text-[11px] font-mono text-text-secondary bg-bg-elevated border border-border-subtle px-2 py-0.5 rounded"
            >
              ~/{sub}
            </span>
          ))}
          {ABSOLUTE_FORBIDDEN_ZONES.map((zone) => (
            <span
              key={zone}
              className="text-[11px] font-mono text-text-secondary bg-bg-elevated border border-border-subtle px-2 py-0.5 rounded"
            >
              {zone}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-text-tertiary mt-2.5 leading-relaxed">
          These paths are denied regardless of any links you add. Cerebro will refuse to link
          a directory inside them at all.
        </p>
      </div>

      {/* Profile preview */}
      <div>
        <button
          onClick={() => setProfileOpen((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer"
        >
          {profileOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          View effective Seatbelt profile
        </button>
        {profileOpen && (
          <pre className="mt-2 px-3 py-2.5 rounded-lg border border-border-subtle bg-bg-base overflow-x-auto text-[11px] leading-[1.55] text-text-tertiary font-mono max-h-80 overflow-y-auto scrollbar-thin">
            {profileText || 'Loading…'}
          </pre>
        )}
      </div>
    </div>
  );
}
