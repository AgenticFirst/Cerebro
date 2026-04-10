import { useState } from 'react';
import { Cpu, CheckCircle2, XCircle, Loader2, ExternalLink, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useProviders } from '../../../context/ProviderContext';

export default function EngineSection() {
  const { claudeCodeInfo, refreshClaudeCodeStatus } = useProviders();
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshClaudeCodeStatus();
    } finally {
      setRefreshing(false);
    }
  };

  const status = claudeCodeInfo.status;
  const isAvailable = status === 'available';
  const isDetecting = status === 'detecting' || status === 'unknown';
  const isUnavailable = status === 'unavailable';
  const isError = status === 'error';

  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">Engine</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        Cerebro uses the Claude Code CLI as its inference engine. All experts, routines,
        and conversations are powered by Claude Code subagents.
      </p>

      <div className="mt-6 bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-violet-500/15 text-violet-400">
            <Cpu size={16} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary">Claude Code</div>
            <div className="text-xs text-text-tertiary">
              Anthropic's official CLI for Claude
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isAvailable && (
              <>
                <CheckCircle2 size={14} className="text-emerald-400" />
                <span className="text-xs text-emerald-400">Detected</span>
              </>
            )}
            {isDetecting && (
              <>
                <Loader2 size={14} className="text-amber-400 animate-spin" />
                <span className="text-xs text-amber-400">Detecting…</span>
              </>
            )}
            {(isUnavailable || isError) && (
              <>
                <XCircle size={14} className="text-red-400" />
                <span className="text-xs text-red-400">
                  {isUnavailable ? 'Not found' : 'Error'}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="border-t border-border-subtle" />

        {/* Details */}
        <div className="px-4 py-3.5 space-y-2">
          {isAvailable && (
            <>
              {claudeCodeInfo.version && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-tertiary">Version</span>
                  <code className="text-text-secondary font-mono">
                    v{claudeCodeInfo.version}
                  </code>
                </div>
              )}
              {claudeCodeInfo.path && (
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-text-tertiary flex-shrink-0">Path</span>
                  <code className="text-text-secondary font-mono truncate">
                    {claudeCodeInfo.path}
                  </code>
                </div>
              )}
            </>
          )}

          {(isUnavailable || isError) && (
            <div className="text-xs text-text-secondary leading-relaxed">
              <p className="mb-2">
                Cerebro could not find the Claude Code CLI on your system.{' '}
                {claudeCodeInfo.error && (
                  <span className="text-red-400">({claudeCodeInfo.error})</span>
                )}
              </p>
              <p>
                Install it from{' '}
                <a
                  href="https://docs.claude.com/en/docs/claude-code/setup"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline inline-flex items-center gap-1"
                >
                  the official setup guide
                  <ExternalLink size={10} />
                </a>{' '}
                and click Re-detect once installed.
              </p>
            </div>
          )}

          <div className="pt-2">
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className={clsx(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
                refreshing
                  ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed'
                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
              )}
            >
              <RefreshCw size={11} className={clsx(refreshing && 'animate-spin')} />
              {refreshing ? 'Detecting…' : 'Re-detect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
