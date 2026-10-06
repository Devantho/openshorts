import { useCallback, useEffect, useMemo, useState } from 'react';
import { Tv, Plus, Trash2, RefreshCw, Loader2, AlertCircle, Check, ExternalLink, Calendar, Clock, ChevronDown, Scissors, X, Pause, Play } from 'lucide-react';
import { apiJson } from '../lib/api';
import PostizChannelPicker from './PostizChannelPicker';

const STATUS = {
  processing: { label: 'clipping…', cls: 'badge-brass' },
  scheduled: { label: 'scheduled', cls: 'badge-ok' },
  failed: { label: 'failed', cls: 'badge-danger' },
  skipped: { label: 'skipped', cls: 'badge-warn' },
};

const fmtDate = (iso, tz, opts) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, { timeZone: tz, ...opts });
  } catch {
    return new Date(iso).toLocaleString();
  }
};

const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

function Badge({ status, jobStatus }) {
  const s = STATUS[status] || { label: status || 'new', cls: 'readout' };
  return <span className={s.cls}>{status === 'processing' && jobStatus === 'queued' ? 'queued' : s.label}</span>;
}

function Feed({ channel, onProcess }) {
  const [feed, setFeed] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    apiJson(`/api/channels/${channel.id}/feed`)
      .then((d) => setFeed(d.videos || []))
      .catch((e) => setError(e.detail || e.message));
  }, [channel.id]);

  if (error) return <p className="text-xs text-danger mt-3">{error}</p>;
  if (!feed) return <p className="text-xs text-muted mt-3 flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> loading latest videos…</p>;
  return (
    <div className="mt-3 border-t border-rule divide-y divide-rule">
      {feed.map((v) => (
        <div key={v.video_id} className="flex items-center gap-3 py-2">
          {v.thumbnail
            ? <img src={v.thumbnail} alt="" className="w-20 aspect-video object-cover rounded-input shrink-0" referrerPolicy="no-referrer" />
            : <div className="w-20 aspect-video bg-paper3 rounded-input shrink-0" />}
          <div className="min-w-0 flex-1">
            <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-sm text-ink hover:text-brass line-clamp-2">{v.title}</a>
            <p className="readout mt-0.5">{fmtDate(v.published, undefined, { dateStyle: 'medium' })}</p>
          </div>
          {v.status
            ? <Badge status={v.status} />
            : (
              <button
                onClick={async () => { setBusy(v.video_id); try { await onProcess(v.video_id); setFeed((f) => f.map((x) => (x.video_id === v.video_id ? { ...x, status: 'processing' } : x))); } finally { setBusy(null); } }}
                disabled={busy === v.video_id}
                className="btn-quiet py-1.5 px-3 text-xs shrink-0"
                title="Clip this video and schedule its clips"
              >
                {busy === v.video_id ? <Loader2 size={12} className="animate-spin" /> : <Scissors size={12} />} clip & schedule
              </button>
            )}
        </div>
      ))}
    </div>
  );
}

export default function ChannelsPage({ channels: postizChannels, channelsError, onOpenSettings, postizConfigured }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(null);
  const [openFeed, setOpenFeed] = useState(null);
  const [form, setForm] = useState(null);
  const [saveState, setSaveState] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await apiJson('/api/channels');
      setData(d);
      setForm((f) => f || { ...d.settings, newTime: '' });
    } catch (e) {
      setError(e.detail || e.message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const timezones = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/Paris']; }
  }, []);

  const call = async (fn) => {
    setError('');
    try {
      const d = await fn();
      if (d?.channels) setData(d);
      return d;
    } catch (e) {
      setError(e.detail || e.message);
      return null;
    }
  };

  const addChannel = async (e) => {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    const d = await call(() => apiJson('/api/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim() }),
    }));
    if (d) setUrl('');
    setAdding(false);
  };

  const saveSettings = async () => {
    setSaveState(null);
    const { newTime: _newTime, ...settings } = form;
    const d = await call(() => apiJson('/api/channels/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
    }));
    if (d) {
      setForm({ ...d.settings, newTime: '' });
      setSaveState('saved');
      setTimeout(() => setSaveState(null), 2500);
    }
  };

  const tz = data?.settings?.timezone;
  const upcomingByDay = useMemo(() => {
    const groups = [];
    for (const s of data?.upcoming || []) {
      const day = fmtDate(s.date, tz, { weekday: 'long', day: 'numeric', month: 'long' });
      const last = groups[groups.length - 1];
      if (last && last.day === day) last.items.push(s);
      else groups.push({ day, items: [s] });
    }
    return groups;
  }, [data?.upcoming, tz]);

  const videoTitle = (id) => data?.videos?.find((v) => v.video_id === id)?.title || id;

  if (!data) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        {error ? <span className="text-danger">{error}</span> : <><Loader2 size={16} className="animate-spin mr-2" /> loading channels…</>}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-8 animate-fade">
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <p className="eyebrow mb-1.5">CHANNEL WATCH</p>
          <h1 className="font-display lowercase text-2xl text-ink">Followed channels</h1>
          <p className="text-sm text-muted mt-2 max-w-2xl">
            Every new video on a followed YouTube channel is sent to the clip generator, then its clips (best first)
            are scheduled on Postiz in the next free slots: {(data.settings.times || []).join(', ')} every day
            ({data.settings.timezone}), within {data.settings.horizon_days} days. Channels are checked every {Math.round(data.poll_seconds / 60)} min.
          </p>
          {data.disabled && <p className="badge-warn mt-3">Channel watch is disabled on the server (CHANNEL_WATCH_DISABLED).</p>}
          {!postizConfigured && (
            <button onClick={onOpenSettings} className="badge-warn mt-3">
              <AlertCircle size={12} /> Postiz is not configured: clips can be generated but not scheduled
            </button>
          )}
        </div>

        {error && (
          <div className="px-3 py-2 rounded-input bg-paper3 text-sm text-danger flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" /> <span className="flex-1 break-words">{error}</span>
            <button onClick={() => setError('')} aria-label="dismiss"><X size={14} /></button>
          </div>
        )}

        <div className="grid lg:grid-cols-5 gap-6">
          {/* Channels */}
          <div className="lg:col-span-3 space-y-4">
            <form onSubmit={addChannel} className="card p-4 flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.youtube.com/@channel or @handle"
                className="input-field"
              />
              <button type="submit" disabled={adding || !url.trim()} className="btn-primary py-2 px-4 text-sm shrink-0">
                {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} follow
              </button>
            </form>

            {data.channels.length === 0 && (
              <div className="card p-8 text-center text-muted text-sm">
                <Tv size={28} className="mx-auto mb-3 text-brass" />
                No channel followed yet. Only videos published after a channel is added are clipped automatically;
                older ones can be clipped by hand from its latest videos.
              </div>
            )}

            {data.channels.map((c) => (
              <div key={c.id} className={`card p-4 ${c.enabled ? '' : 'opacity-60'}`}>
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0"><Tv size={16} className="text-brass" /></div>
                  <div className="min-w-0 flex-1">
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="text-ink font-medium hover:text-brass flex items-center gap-1.5">
                      <span className="truncate">{c.title}</span> <ExternalLink size={12} className="shrink-0" />
                    </a>
                    <p className="readout mt-0.5">
                      followed {fmtDate(c.added_at, tz, { dateStyle: 'medium' })} · checked {ago(c.last_checked)}{c.source && ` · via ${c.source}`}
                    </p>
                    {c.last_error && <p className="text-xs text-danger mt-1 break-words">{c.last_error}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={async () => { setChecking(c.id); await call(() => apiJson(`/api/channels/${c.id}/check`, { method: 'POST' })); setChecking(null); }}
                      disabled={checking === c.id}
                      className="btn-ghost p-2" title="Check now"
                    >
                      <RefreshCw size={14} className={checking === c.id ? 'animate-spin' : ''} />
                    </button>
                    <button
                      onClick={() => call(() => apiJson(`/api/channels/${c.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !c.enabled }),
                      }))}
                      className="btn-ghost p-2" title={c.enabled ? 'Pause' : 'Resume'}
                    >
                      {c.enabled ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Stop following ${c.title}?`)) call(() => apiJson(`/api/channels/${c.id}`, { method: 'DELETE' })); }}
                      className="btn-ghost p-2" title="Unfollow"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <button onClick={() => setOpenFeed(openFeed === c.id ? null : c.id)} className="text-xs text-muted hover:text-ink mt-3 flex items-center gap-1 lowercase">
                  <ChevronDown size={12} className={openFeed === c.id ? 'rotate-180' : ''} /> latest videos
                </button>
                {openFeed === c.id && (
                  <Feed
                    channel={c}
                    onProcess={(videoId) => call(() => apiJson('/api/channels/process', {
                      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: c.id, video_id: videoId }),
                    }))}
                  />
                )}
              </div>
            ))}

            {/* Processed videos */}
            {data.videos.length > 0 && (
              <div className="card p-4">
                <h2 className="eyebrow mb-3">DETECTED VIDEOS</h2>
                <div className="divide-y divide-rule">
                  {data.videos.map((v) => (
                    <div key={v.video_id} className="py-2.5 flex items-start gap-3">
                      {v.thumbnail
                        ? <img src={v.thumbnail} alt="" className="w-20 aspect-video object-cover rounded-input shrink-0" referrerPolicy="no-referrer" />
                        : <div className="w-20 aspect-video bg-paper3 rounded-input shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <a href={v.url} target="_blank" rel="noopener noreferrer" className="text-sm text-ink hover:text-brass line-clamp-2">{v.title}</a>
                        <p className="readout mt-0.5">{v.channel_title} · detected {ago(v.detected_at)}</p>
                        {v.planned?.length > 0 && (
                          <p className="text-xs text-muted mt-1">
                            {v.planned.length} clip(s): {v.planned.map((p) => fmtDate(p.date, tz, { weekday: 'short', hour: '2-digit', minute: '2-digit' })).join(' · ')}
                            {v.unscheduled > 0 && ` · ${v.unscheduled} not scheduled (no free slot)`}
                          </p>
                        )}
                        {v.error && <p className="text-xs text-danger mt-1 break-words">{v.error}</p>}
                      </div>
                      <Badge status={v.status} jobStatus={v.job_status} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Schedule */}
          <div className="lg:col-span-2 space-y-4">
            <div className="card p-4">
              <h2 className="eyebrow mb-3 flex items-center gap-2"><Calendar size={12} /> UPCOMING POSTS</h2>
              {upcomingByDay.length === 0
                ? <p className="text-xs text-muted">Nothing scheduled yet.</p>
                : upcomingByDay.map((g) => (
                  <div key={g.day} className="mb-3 last:mb-0">
                    <p className="text-xs text-ink2 lowercase mb-1">{g.day}</p>
                    {g.items.map((s) => (
                      <div key={s.date} className="flex items-center gap-2 py-1 text-xs">
                        <span className="readout w-12 shrink-0">{fmtDate(s.date, tz, { hour: '2-digit', minute: '2-digit' })}</span>
                        <span className="text-ink2 truncate flex-1" title={videoTitle(s.video_id)}>{s.title || `clip ${s.clip_index + 1}`}</span>
                        {s.status === 'reserved' && <Loader2 size={11} className="animate-spin text-brass shrink-0" />}
                      </div>
                    ))}
                  </div>
                ))}
            </div>

            {form && (
              <div className="card p-4 space-y-4">
                <h2 className="eyebrow flex items-center gap-2"><Clock size={12} /> PUBLISHING SLOTS</h2>
                <div>
                  <span className="text-xs text-muted block mb-2">Every day at</span>
                  <div className="flex flex-wrap gap-2">
                    {form.times.map((t) => (
                      <span key={t} className="badge-brass">
                        {t}
                        <button onClick={() => setForm({ ...form, times: form.times.filter((x) => x !== t) })} aria-label={`remove ${t}`}><X size={11} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input type="time" value={form.newTime} onChange={(e) => setForm({ ...form, newTime: e.target.value })} className="input-field [color-scheme:dark]" />
                    <button
                      onClick={() => form.newTime && !form.times.includes(form.newTime) && setForm({ ...form, times: [...form.times, form.newTime].sort(), newTime: '' })}
                      className="btn-quiet py-2 px-3 text-xs shrink-0"
                    >
                      <Plus size={12} /> add
                    </button>
                  </div>
                </div>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted block">Timezone</span>
                  <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className="input-field appearance-none cursor-pointer">
                    {timezones.map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-3">
                  <label className="block space-y-1.5">
                    <span className="text-xs text-muted block">Within (days)</span>
                    <input type="number" min={1} max={30} value={form.horizon_days} onChange={(e) => setForm({ ...form, horizon_days: Number(e.target.value) })} className="input-field" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="text-xs text-muted block">Max clips / video (0 = all)</span>
                    <input type="number" min={0} max={50} value={form.max_clips_per_video} onChange={(e) => setForm({ ...form, max_clips_per_video: Number(e.target.value) })} className="input-field" />
                  </label>
                </div>
                <label className="block space-y-1.5">
                  <span className="text-xs text-muted block">Mode</span>
                  <select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })} className="input-field appearance-none cursor-pointer">
                    <option value="schedule">schedule (publishes on time)</option>
                    <option value="draft">draft in Postiz (review first)</option>
                  </select>
                </label>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm text-ink2 cursor-pointer">
                    <input type="checkbox" checked={!!form.skip_shorts} onChange={(e) => setForm({ ...form, skip_shorts: e.target.checked })} className="w-4 h-4 accent-brass" />
                    ignore YouTube Shorts
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink2 cursor-pointer">
                    <input type="checkbox" checked={!!form.auto_hook} onChange={(e) => setForm({ ...form, auto_hook: e.target.checked })} className="w-4 h-4 accent-brass" />
                    add the hook text overlay
                  </label>
                </div>
                <div>
                  <span className="text-xs text-muted block mb-2">Postiz channels (empty = the auto-post channels from Settings)</span>
                  {postizConfigured
                    ? <PostizChannelPicker channels={postizChannels} error={channelsError} value={form.integration_ids || []} onChange={(ids) => setForm({ ...form, integration_ids: ids })} />
                    : <button onClick={onOpenSettings} className="text-xs text-brass hover:underline">configure Postiz →</button>}
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={saveSettings} disabled={!form.times.length} className="btn-primary py-2 px-4 text-sm">Save</button>
                  {saveState && <span className="badge-ok"><Check size={12} /> saved</span>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
