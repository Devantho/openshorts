import { useEffect, useState } from 'react';
import { Share2, Loader2, Check, AlertCircle, Calendar, Send, FileEdit } from 'lucide-react';
import Modal from './ui/Modal';
import SegmentedControl from './ui/SegmentedControl';
import PostizChannelPicker from './PostizChannelPicker';
import { apiJson } from '../lib/api';

const MODES = [
  { value: 'now', label: 'publish now', icon: <Send size={14} /> },
  { value: 'schedule', label: 'schedule', icon: <Calendar size={14} /> },
  { value: 'draft', label: 'draft', icon: <FileEdit size={14} /> },
];

/**
 * Publish one video through the server's Postiz instance.
 *
 * `source` is what the backend resolves to a file: {kind: 'clip', job_id,
 * clip_index} for a generated clip or {kind: 'saas', job_id} for an AI Short.
 * `channels` are the Postiz integrations (GET /api/postiz/integrations).
 */
export default function PostizPostModal({ isOpen, onClose, source, defaultTitle = '', defaultDescription = '', channels, channelsError, onOpenSettings }) {
  const [selected, setSelected] = useState([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState('now');
  const [date, setDate] = useState('');
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    setTitle(defaultTitle || '');
    setDescription(defaultDescription || '');
    setMode('now');
    setDate('');
    setResult(null);
    setSelected((channels || []).filter((c) => !c.disabled).map((c) => c.id));
    // Reset only when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const notConfigured = channels === null;
  const noChannels = Array.isArray(channels) && channels.filter((c) => !c.disabled).length === 0;

  const submit = async () => {
    if (!selected.length) return setResult({ ok: false, msg: 'Select at least one channel.' });
    if (mode === 'schedule' && !date) return setResult({ ok: false, msg: 'Pick a date and time.' });
    setPosting(true);
    setResult(null);
    try {
      const data = await apiJson('/api/postiz/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...source,
          integration_ids: selected,
          title,
          description,
          mode,
          scheduled_date: mode === 'schedule' ? new Date(date).toISOString() : null,
        }),
      });
      const where = (data.channels || []).join(', ');
      setResult({
        ok: true,
        msg: mode === 'now' ? `Sent to Postiz → ${where}` : mode === 'schedule' ? `Scheduled on ${where}` : `Draft created in Postiz`,
      });
      setTimeout(() => onClose(), 2500);
    } catch (e) {
      setResult({ ok: false, msg: e.detail || e.message });
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      eyebrow="PUBLISH · POSTIZ"
      title="post video"
      size="md"
      footer={
        notConfigured ? (
          <button onClick={() => { onClose(); onOpenSettings?.(); }} className="btn-primary w-full">configure postiz</button>
        ) : (
          <button onClick={submit} disabled={posting || noChannels || !selected.length} className="btn-primary w-full">
            {posting
              ? <><Loader2 size={16} className="animate-spin" /> uploading…</>
              : <><Share2 size={16} /> {mode === 'now' ? 'publish now' : mode === 'schedule' ? 'schedule post' : 'create draft'}</>}
          </button>
        )
      }
    >
      {notConfigured ? (
        <div className="px-3 py-2 rounded-input text-xs text-warn bg-paper3 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" />
          <div>Postiz is not configured. Add your Postiz URL and API key in Settings.</div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="eyebrow block mb-2">CHANNELS</label>
            <PostizChannelPicker channels={channels} error={channelsError} value={selected} onChange={setSelected} />
          </div>
          <div>
            <label className="eyebrow block mb-1.5">TITLE (YOUTUBE · TIKTOK)</label>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} className="input-field" />
          </div>
          <div>
            <label className="eyebrow block mb-1.5">CAPTION</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="input-field resize-none" />
            <p className="text-xs text-muted mt-1">Default hashtags from Settings are appended.</p>
          </div>
          <div>
            <label className="eyebrow block mb-2">WHEN</label>
            <SegmentedControl options={MODES} value={mode} onChange={setMode} size="sm" />
            {mode === 'schedule' && (
              <input
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="input-field mt-3 [color-scheme:dark]"
              />
            )}
          </div>
          {result && (
            <div className={result.ok ? 'badge-ok' : 'badge-danger'}>
              {result.ok ? <Check size={12} className="shrink-0" /> : <AlertCircle size={12} className="shrink-0" />}
              <span className="break-words">{result.msg}</span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
