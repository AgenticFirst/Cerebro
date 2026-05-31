/**
 * WhatsApp Operator Clients — manage multiple business profiles.
 *
 * Each "client" is a business the operator manages. The operator configures
 * the business name, description, hours, and AI persona. When the WhatsApp
 * bridge is active, the AI uses the active client's profile.
 */

import { useCallback, useEffect, useState } from 'react';
import { Building2, Plus, Trash2, Edit3, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';

interface Client {
  id: string;
  name: string;
  business_name: string;
  business_description: string;
  business_hours: string;
  powered_by_footer: boolean;
  is_active: boolean;
}

interface ClientFormData {
  name: string;
  business_name: string;
  business_description: string;
  business_hours: string;
  powered_by_footer: boolean;
}

const emptyForm = (): ClientFormData => ({
  name: '',
  business_name: '',
  business_description: '',
  business_hours: '',
  powered_by_footer: true,
});

interface Props {
  backendPort: number;
  onApplyProfile: (client: Client) => void;
}

export default function WhatsAppOperatorClients({ backendPort, onApplyProfile }: Props) {
  const [clients, setClients] = useState<Client[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<ClientFormData>(emptyForm());
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  const base = `http://127.0.0.1:${backendPort}`;

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/whatsapp-clients`);
      if (res.ok) setClients(await res.json());
    } catch { /* ignore */ }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      const res = editing
        ? await fetch(`${base}/whatsapp-clients/${editing}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        })
        : await fetch(`${base}/whatsapp-clients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(form),
        });
      if (res.ok) {
        const saved: Client = await res.json();
        setSavedId(saved.id);
        setTimeout(() => setSavedId(null), 1500);
        await load();
        setShowAdd(false);
        setEditing(null);
        setForm(emptyForm());
      }
    } finally {
      setSaving(false);
    }
  }, [base, editing, form, load]);

  const del = useCallback(async (id: string) => {
    if (!confirm('Delete this client?')) return;
    await fetch(`${base}/whatsapp-clients/${id}`, { method: 'DELETE' });
    await load();
  }, [base, load]);

  const startEdit = useCallback((c: Client) => {
    setEditing(c.id);
    setForm({
      name: c.name,
      business_name: c.business_name,
      business_description: c.business_description,
      business_hours: c.business_hours,
      powered_by_footer: c.powered_by_footer,
    });
    setShowAdd(true);
    setExpanded(null);
  }, []);

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-accent" />
          <span className="text-sm font-medium text-text-primary">Operator Clients</span>
          <span className="text-[10px] bg-accent/10 text-accent border border-accent/20 px-1.5 py-0.5 rounded-full">
            {clients.length} client{clients.length !== 1 ? 's' : ''}
          </span>
        </div>
        {!showAdd && (
          <button
            type="button"
            onClick={() => { setShowAdd(true); setEditing(null); setForm(emptyForm()); }}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-accent/15 text-accent hover:bg-accent/25"
          >
            <Plus size={12} /> Add client
          </button>
        )}
      </div>

      {/* Add / Edit form */}
      {showAdd && (
        <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-4 space-y-3">
          <h4 className="text-xs font-medium text-text-primary">
            {editing ? 'Edit client' : 'New client'}
          </h4>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Client label (internal, e.g. Dr. Martinez Clinic)"
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
          <input
            type="text"
            value={form.business_name}
            onChange={(e) => setForm({ ...form, business_name: e.target.value })}
            placeholder="Business name shown to customers"
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
          <textarea
            value={form.business_description}
            onChange={(e) => setForm({ ...form, business_description: e.target.value })}
            placeholder="What the business offers (1-2 sentences)"
            rows={2}
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50 resize-none"
          />
          <input
            type="text"
            value={form.business_hours}
            onChange={(e) => setForm({ ...form, business_hours: e.target.value })}
            placeholder="Business hours (e.g. Mon–Fri 9am–6pm)"
            className="w-full bg-bg-surface border border-border-subtle rounded-md px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/50"
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={form.powered_by_footer}
              onChange={(e) => setForm({ ...form, powered_by_footer: e.target.checked })}
              className="rounded accent-accent"
            />
            <span className="text-xs text-text-secondary">Add "✨ Powered by Cerebro AI" footer</span>
          </label>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => { setShowAdd(false); setEditing(null); setForm(emptyForm()); }}
              className="px-3 py-1.5 text-xs rounded-md text-text-tertiary hover:text-text-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !form.name.trim()}
              className="px-3 py-1.5 text-xs rounded-md font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? 'Saving…' : editing ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Client list */}
      {clients.length === 0 && !showAdd && (
        <p className="text-xs text-text-tertiary py-3 text-center">
          No clients yet. Add your first client to get started.
        </p>
      )}
      <div className="space-y-2">
        {clients.map((c) => (
          <div key={c.id} className="rounded-lg border border-border-subtle bg-bg-surface overflow-hidden">
            <div
              className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-bg-elevated"
              onClick={() => setExpanded(expanded === c.id ? null : c.id)}
            >
              <Building2 size={13} className="text-text-tertiary flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-text-primary truncate">{c.name}</div>
                {c.business_name && (
                  <div className="text-[10px] text-text-tertiary truncate">{c.business_name}</div>
                )}
              </div>
              {savedId === c.id && <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" />}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onApplyProfile(c); }}
                className="px-2 py-0.5 text-[10px] rounded bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 flex-shrink-0"
              >
                Apply
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); startEdit(c); }}
                className="text-text-tertiary hover:text-text-primary flex-shrink-0"
              >
                <Edit3 size={12} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); void del(c.id); }}
                className="text-text-tertiary hover:text-red-400 flex-shrink-0"
              >
                <Trash2 size={12} />
              </button>
              {expanded === c.id ? <ChevronUp size={12} className="text-text-tertiary" /> : <ChevronDown size={12} className="text-text-tertiary" />}
            </div>
            {expanded === c.id && (
              <div className="px-3 pb-3 space-y-1 border-t border-border-subtle pt-2">
                {c.business_description && (
                  <p className="text-[11px] text-text-secondary">{c.business_description}</p>
                )}
                {c.business_hours && (
                  <p className="text-[11px] text-text-tertiary">⏰ {c.business_hours}</p>
                )}
                <p className="text-[11px] text-text-tertiary">
                  {c.powered_by_footer ? '✨ Footer: on' : '🔇 Footer: off'}
                </p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
