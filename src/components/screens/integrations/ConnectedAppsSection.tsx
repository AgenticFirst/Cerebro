import { useState, useEffect, type ComponentType } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import clsx from 'clsx';
import {
  GoogleCalendarIcon,
  GmailIcon,
  NotionIcon,
  SlackIcon,
  TavilyIcon,
  BraveIcon,
} from '../../icons/BrandIcons';

interface Service {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  color: string;
  textColor: string;
}

const COMING_SOON_SERVICES: Service[] = [
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'High-performance web search',
    icon: BraveIcon,
    color: 'bg-orange-500/15',
    textColor: 'text-orange-400',
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Calendar events and scheduling',
    icon: GoogleCalendarIcon,
    color: 'bg-blue-500/15',
    textColor: 'text-blue-400',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description: 'Read and send emails',
    icon: GmailIcon,
    color: 'bg-red-500/15',
    textColor: 'text-red-400',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Pages, databases, and knowledge base',
    icon: NotionIcon,
    color: 'bg-white/10',
    textColor: 'text-white/80',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Team messaging and notifications',
    icon: SlackIcon,
    color: 'bg-purple-500/15',
    textColor: 'text-purple-400',
  },
];

function ComingSoonCard({ service }: { service: Service }) {
  const Icon = service.icon;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5 bg-bg-surface border border-border-subtle rounded-lg">
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          service.color,
          service.textColor,
        )}
      >
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{service.name}</div>
        <div className="text-xs text-text-tertiary">{service.description}</div>
      </div>
      <span className="text-[10px] font-medium text-text-tertiary bg-bg-elevated px-2 py-1 rounded-full border border-border-subtle flex-shrink-0">
        Coming Soon
      </span>
    </div>
  );
}

type TavilyStatus = 'not_configured' | 'key_saved' | 'verifying' | 'connected' | 'error';

function TavilyCard() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<TavilyStatus>('not_configured');
  const [error, setError] = useState('');

  const inputHasValue = apiKey.length > 0;

  useEffect(() => {
    window.cerebro.credentials.has('tavily', 'api_key').then((has) => {
      setSaved(has);
      if (has) setStatus('key_saved');
    });
  }, []);

  const handleSave = async () => {
    setError('');
    setSaving(true);
    const result = await window.cerebro.credentials.set({
      service: 'tavily',
      key: 'api_key',
      value: apiKey,
      label: 'Tavily API Key',
    });
    setSaving(false);

    if (result.ok) {
      setSaved(true);
      setApiKey('');
      setStatus('key_saved');
    } else {
      setError(result.error ?? 'Failed to save credential');
    }
  };

  const handleRemove = async () => {
    const result = await window.cerebro.credentials.delete('tavily', 'api_key');
    if (result.ok) {
      setSaved(false);
      setStatus('not_configured');
      setError('');
    }
  };

  const handleTest = async () => {
    setStatus('verifying');
    setError('');
    try {
      const res = await window.cerebro.backend.request({
        method: 'POST',
        path: '/search/verify',
      });
      if (res.ok && (res.data as any)?.valid) {
        setStatus('connected');
      } else {
        setStatus('error');
        setError((res.data as any)?.error ?? 'Verification failed');
      }
    } catch {
      setStatus('error');
      setError('Failed to reach backend');
    }
  };

  const statusConfig: Record<
    TavilyStatus,
    { dot: string; label: string; labelColor: string; pulse?: boolean }
  > = {
    not_configured: {
      dot: 'bg-text-tertiary',
      label: 'Not configured',
      labelColor: 'text-text-tertiary',
    },
    key_saved: {
      dot: 'bg-amber-400',
      label: 'Key saved',
      labelColor: 'text-amber-400',
    },
    verifying: {
      dot: 'bg-amber-400',
      label: 'Verifying...',
      labelColor: 'text-amber-400',
      pulse: true,
    },
    connected: {
      dot: 'bg-emerald-400',
      label: 'Connected',
      labelColor: 'text-emerald-400',
    },
    error: {
      dot: 'bg-red-400',
      label: 'Error',
      labelColor: 'text-red-400',
    },
  };

  const sc = statusConfig[status];

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-cyan-500/15 text-cyan-400">
          <TavilyIcon size={16} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-text-primary">Tavily</div>
          <div className="text-xs text-text-tertiary">AI-powered web search</div>
        </div>
        <div className="flex items-center gap-1.5">
          <div
            className={clsx('w-1.5 h-1.5 rounded-full', sc.dot, sc.pulse && 'animate-pulse')}
          />
          <span className={clsx('text-xs', sc.labelColor)}>{sc.label}</span>
          {saved && (
            <button
              onClick={handleRemove}
              className="text-xs text-text-tertiary hover:text-red-400 transition-colors cursor-pointer ml-2"
            >
              Remove
            </button>
          )}
        </div>
      </div>

      <div className="border-t border-border-subtle" />

      {/* API Key */}
      <div className="px-4 py-3.5">
        <label className="text-xs font-medium text-text-secondary mb-2 block">API Key</label>
        <div className="flex gap-2">
          <div className="flex-1 relative">
            <input
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setError('');
              }}
              placeholder={
                saved ? 'Key saved securely \u2014 enter new key to replace' : 'tvly-...'
              }
              className="w-full bg-bg-base border border-border-default rounded-md px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-tertiary/50 focus:outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20 transition-colors"
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text-secondary transition-colors cursor-pointer p-0.5"
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button
            onClick={handleSave}
            className={clsx(
              'px-3 py-2 rounded-md text-xs font-medium transition-colors',
              inputHasValue && !saving
                ? 'bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 cursor-pointer'
                : 'bg-bg-elevated text-text-tertiary border border-border-subtle cursor-not-allowed',
            )}
            disabled={!inputHasValue || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {saved && (
            <button
              onClick={handleTest}
              disabled={status === 'verifying'}
              className={clsx(
                'px-3 py-2 rounded-md text-xs font-medium transition-colors border',
                status === 'verifying'
                  ? 'bg-bg-elevated text-text-tertiary border-border-subtle cursor-not-allowed'
                  : 'bg-bg-elevated text-text-secondary hover:text-text-primary hover:bg-bg-hover border-border-subtle cursor-pointer',
              )}
            >
              {status === 'verifying' ? 'Testing...' : 'Test'}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
        <p className="text-xs text-text-tertiary mt-2 leading-relaxed">
          Enables the web search tool for all experts. Get a free API key at{' '}
          <a
            href="https://tavily.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent hover:underline"
          >
            tavily.com
          </a>{' '}
          (1,000 searches/month free).
        </p>
      </div>
    </div>
  );
}

export default function ConnectedAppsSection() {
  return (
    <div>
      <h2 className="text-lg font-medium text-text-primary">Connected Apps</h2>
      <p className="text-sm text-text-secondary mt-1 leading-relaxed">
        Connect external services so Cerebro can read and write on your behalf.
      </p>

      {/* Active services */}
      <div className="mt-6 space-y-3">
        <TavilyCard />
      </div>

      {/* Coming soon */}
      <div className="mt-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary mb-3">
          Coming Soon
        </div>
        <div className="space-y-2">
          {COMING_SOON_SERVICES.map((service) => (
            <ComingSoonCard key={service.id} service={service} />
          ))}
        </div>
      </div>
    </div>
  );
}
