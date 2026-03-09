import { Terminal, ExternalLink, RefreshCw } from 'lucide-react';
import clsx from 'clsx';
import { useProviders } from '../../../context/ProviderContext';

export default function ClaudeCodeCard() {
  const { claudeCodeInfo, refreshClaudeCodeStatus, selectModel, selectedModel } = useProviders();

  const isAvailable = claudeCodeInfo.status === 'available';
  const isDetecting = claudeCodeInfo.status === 'detecting';
  const isSelected = selectedModel?.source === 'claude-code';

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="w-8 h-8 rounded-lg bg-violet-500/15 flex items-center justify-center text-violet-400">
          <Terminal size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">Claude Code</div>
          <div className="text-xs text-text-tertiary">
            Full agent with file editing, bash, search
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={clsx(
              'w-1.5 h-1.5 rounded-full',
              isAvailable ? 'bg-emerald-400' : isDetecting ? 'bg-amber-400 animate-pulse' : 'bg-text-tertiary',
            )}
          />
          <span
            className={clsx(
              'text-xs',
              isAvailable ? 'text-emerald-400' : isDetecting ? 'text-amber-400' : 'text-text-tertiary',
            )}
          >
            {isAvailable ? 'Detected' : isDetecting ? 'Detecting...' : 'Not installed'}
          </span>
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* Body */}
      <div className="px-4 py-3.5">
        {isAvailable ? (
          <div className="space-y-3">
            {/* Version & path info */}
            <div className="flex items-center gap-4 text-xs">
              {claudeCodeInfo.version && (
                <div>
                  <span className="text-text-tertiary">Version: </span>
                  <span className="text-text-secondary font-mono">v{claudeCodeInfo.version}</span>
                </div>
              )}
              {claudeCodeInfo.path && (
                <div className="truncate">
                  <span className="text-text-tertiary">Path: </span>
                  <span className="text-text-secondary font-mono">{claudeCodeInfo.path}</span>
                </div>
              )}
            </div>

            {/* Capabilities */}
            <p className="text-xs text-text-tertiary leading-relaxed">
              Uses Claude Code&apos;s built-in agent loop with tools for reading/editing files,
              running bash commands, searching the web, and more. Expert knowledge is automatically
              injected into context.
            </p>

            {/* Actions */}
            <div className="flex items-center gap-2">
              {!isSelected && (
                <button
                  onClick={() =>
                    selectModel({
                      source: 'claude-code',
                      modelId: 'claude-code',
                      displayName: 'Claude Code',
                    })
                  }
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 border border-violet-500/20 transition-colors cursor-pointer"
                >
                  Select as default
                </button>
              )}
              {isSelected && (
                <span className="text-xs text-violet-400 font-medium">Currently active</span>
              )}
              <button
                onClick={refreshClaudeCodeStatus}
                disabled={isDetecting}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
                title="Re-detect"
              >
                <RefreshCw size={12} className={isDetecting ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-text-tertiary leading-relaxed">
              Claude Code is a powerful CLI agent from Anthropic. Install it to use as
              Cerebro&apos;s brain — it includes advanced tools for code editing, bash execution,
              and web search.
            </p>
            <div className="flex items-center gap-2">
              <a
                href="https://docs.anthropic.com/en/docs/claude-code/overview"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 border border-violet-500/20 transition-colors"
              >
                Install guide <ExternalLink size={10} />
              </a>
              <button
                onClick={refreshClaudeCodeStatus}
                disabled={isDetecting}
                className="p-1.5 rounded-md text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
                title="Re-detect"
              >
                <RefreshCw size={12} className={isDetecting ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
        )}

        {claudeCodeInfo.error && (
          <p className="text-xs text-red-400 mt-2">{claudeCodeInfo.error}</p>
        )}
      </div>
    </div>
  );
}
