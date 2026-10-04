import { Check, Loader2, AlertCircle } from 'lucide-react';

/** Multi-select list of Postiz channels (integrations). */
export default function PostizChannelPicker({ channels, error, value, onChange }) {
  if (error) {
    return (
      <div className="px-3 py-2 rounded-input text-xs text-danger bg-paper3 flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> <span className="break-words">{error}</span>
      </div>
    );
  }
  if (channels === undefined) {
    return <div className="text-xs text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> loading channels…</div>;
  }
  if (!channels || channels.length === 0) {
    return <div className="text-xs text-muted">No channel connected in Postiz yet. Add YouTube, TikTok, Instagram… in your Postiz instance.</div>;
  }
  const toggle = (id) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {channels.map((c) => {
        const on = value.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            disabled={c.disabled}
            onClick={() => toggle(c.id)}
            className={`flex items-center gap-2 px-3 py-2 rounded-input border text-left transition-colors ${on ? 'border-brass bg-paper3' : 'border-rule hover:bg-paper3'} disabled:opacity-40 disabled:cursor-not-allowed`}
            title={c.disabled ? 'disabled in Postiz' : c.profile || c.name}
          >
            {c.picture
              ? <img src={c.picture} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" referrerPolicy="no-referrer" />
              : <span className="w-6 h-6 rounded-full bg-paper3 border border-rule shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block text-sm text-ink truncate">{c.name}</span>
              <span className="block text-micro text-muted lowercase">{c.identifier}</span>
            </span>
            {on && <Check size={14} className="text-brass shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}
