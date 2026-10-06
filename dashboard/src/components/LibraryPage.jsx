import { useCallback, useEffect, useMemo, useState } from 'react';
import { Film, Search, Loader2, Download, Trash2, ExternalLink, ArrowLeft, Calendar, RefreshCw, Upload, AlertCircle } from 'lucide-react';
import { apiJson } from '../lib/api';
import { applySubtitlesToAll, downloadAllClips } from '../lib/clipActions';
import ResultCard from './ResultCard';
import ClipEditor from './ClipEditor';
import ReframeEditor from './ReframeEditor';

const STATUS = {
  queued: { label: 'queued', cls: 'badge-brass' },
  processing: { label: 'clipping…', cls: 'badge-brass' },
  failed: { label: 'failed', cls: 'badge-danger' },
};

const fmt = (ts, opts) => {
  if (!ts) return '';
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString(undefined, opts);
};

const retentionText = (s) => (s >= 86400 ? `${Math.round(s / 86400)} days` : `${Math.round(s / 3600)} h`);

function SourceItem({ item, active, onClick }) {
  const st = STATUS[item.status];
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex gap-3 p-2 rounded-input transition-colors ${active ? 'bg-paper3 ring-1 ring-brass/60' : 'hover:bg-paper3/60'}`}
    >
      <div className="w-28 aspect-video rounded-input overflow-hidden bg-paper3 shrink-0 flex items-center justify-center">
        {item.thumbnail
          ? <img src={item.thumbnail} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" loading="lazy" />
          : item.upload_name ? <Upload size={16} className="text-muted" /> : <Film size={16} className="text-muted" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink line-clamp-2 leading-snug">{item.title}</p>
        <p className="readout mt-1 truncate">
          {item.channel_title ? `${item.channel_title} · ` : ''}{fmt(item.created_at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
        </p>
        <div className="flex items-center gap-1.5 mt-1">
          {st ? <span className={st.cls}>{st.label}</span> : <span className="readout">{item.clip_count} clip{item.clip_count === 1 ? '' : 's'}</span>}
          {item.scheduled?.length > 0 && <span className="badge-ok"><Calendar size={10} /> {item.scheduled.length}</span>}
        </div>
      </div>
    </button>
  );
}

export default function LibraryPage({ keys, channels, channelsError, onOpenSettings }) {
  const [list, setList] = useState(null);
  const [retention, setRetention] = useState(0);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);       // job_id
  const [job, setJob] = useState(null);                 // /api/status payload of the selected job
  const [loadingJob, setLoadingJob] = useState(false);
  const [editingClip, setEditingClip] = useState(null);
  const [reframingClip, setReframingClip] = useState(null);
  const [bulkSub, setBulkSub] = useState({ running: false, current: 0, total: 0, errors: 0 });
  const [zipping, setZipping] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const d = await apiJson('/api/library');
      setList(d.jobs || []);
      setRetention(d.retention_seconds || 0);
      setError('');
    } catch (e) {
      setError(e.detail || e.message);
    }
  }, []);

  const loadJob = useCallback(async (jobId, { quiet = false } = {}) => {
    if (!quiet) setLoadingJob(true);
    try {
      const d = await apiJson(`/api/status/${jobId}`);
      setJob({ ...d, job_id: jobId });
    } catch (e) {
      if (!quiet) setJob({ job_id: jobId, error: e.detail || e.message });
    } finally {
      if (!quiet) setLoadingJob(false);
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, 20000);
    return () => clearInterval(t);
  }, [loadList]);

  // Pick the newest source on first load (desktop only: on a phone the list is the page).
  useEffect(() => {
    if (!selected && list?.length && window.innerWidth >= 1024) setSelected(list[0].job_id);
  }, [list, selected]);

  useEffect(() => {
    if (!selected) { setJob(null); return undefined; }
    loadJob(selected);
    return undefined;
  }, [selected, loadJob]);

  // A job still rendering: follow it until it lands.
  useEffect(() => {
    if (!job || !['queued', 'processing'].includes(job.status)) return undefined;
    const t = setInterval(() => loadJob(job.job_id, { quiet: true }), 4000);
    return () => clearInterval(t);
  }, [job, loadJob]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!list) return [];
    if (!q) return list;
    return list.filter((i) => `${i.title} ${i.channel_title || ''} ${i.url || ''}`.toLowerCase().includes(q));
  }, [list, query]);

  const entry = list?.find((i) => i.job_id === selected);
  const clips = useMemo(() => job?.result?.clips || [], [job]);
  const ranked = useMemo(() => clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.video_url)
    .sort((a, b) => {
      const sa = Number.isFinite(a.clip?.predicted_score) ? a.clip.predicted_score : -1;
      const sb = Number.isFinite(b.clip?.predicted_score) ? b.clip.predicted_score : -1;
      return sb - sa || a.index - b.index;
    }), [clips]);

  const onRerendered = (index, data) => {
    setJob((prev) => {
      if (!prev?.result?.clips?.[index]) return prev;
      const next = prev.result.clips.slice();
      next[index] = { ...next[index], video_url: data.new_video_url, start: data.start, end: data.end, recipe: data.recipe };
      return { ...prev, result: { ...prev.result, clips: next } };
    });
  };

  const bulkSubtitles = async (options) => {
    if (!clips.length) return;
    await applySubtitlesToAll(selected, clips, options, setBulkSub);
    loadJob(selected, { quiet: true });
  };

  const deleteJob = async () => {
    if (!entry || !window.confirm(`Delete "${entry.title}" and its ${entry.clip_count} clip(s) from the server?`)) return;
    try {
      await apiJson(`/api/library/${selected}`, { method: 'DELETE' });
      setSelected(null);
      loadList();
    } catch (e) {
      setError(e.detail || e.message);
    }
  };

  const zip = async () => {
    setZipping(true);
    try {
      await downloadAllClips(selected, (entry?.title || 'clips').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || undefined);
    } catch (e) {
      setError(e.message);
    } finally {
      setZipping(false);
    }
  };

  if (!list) {
    return (
      <div className="h-full flex items-center justify-center text-muted text-sm">
        {error ? <span className="text-danger">{error}</span> : <><Loader2 size={16} className="animate-spin mr-2" /> loading clips…</>}
      </div>
    );
  }

  return (
    <div className="h-full flex overflow-hidden animate-fade">
      {/* Left: source videos */}
      <aside className={`${selected ? 'hidden lg:flex' : 'flex'} w-full lg:w-[340px] xl:w-[380px] shrink-0 flex-col border-r border-rule bg-paper2/40`}>
        <div className="p-4 border-b border-rule space-y-3 shrink-0">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="eyebrow">LIBRARY</p>
              <h1 className="font-display lowercase text-xl text-ink">Generated clips</h1>
            </div>
            <button onClick={loadList} className="btn-ghost p-2" title="Refresh"><RefreshCw size={14} /></button>
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search a video or channel" className="input-field pl-9 py-2 text-sm" />
          </div>
          {retention > 0 && <p className="text-xs text-muted">Clips are kept {retentionText(retention)} on the server (JOB_RETENTION_SECONDS).</p>}
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
          {filtered.length === 0 && (
            <p className="text-sm text-muted text-center p-6">
              {list.length === 0 ? 'No clips yet. Generate some from the Clip Generator or follow a channel.' : 'No match.'}
            </p>
          )}
          {filtered.map((item) => (
            <SourceItem key={item.job_id} item={item} active={item.job_id === selected} onClick={() => setSelected(item.job_id)} />
          ))}
        </div>
      </aside>

      {/* Right: the clips of the selected video */}
      <section className={`${selected ? 'flex' : 'hidden lg:flex'} flex-1 min-w-0 flex-col overflow-hidden`}>
        {!selected ? (
          <div className="flex-1 flex items-center justify-center text-muted text-sm">Select a video to see its clips.</div>
        ) : (
          <>
            <div className="p-4 sm:px-6 border-b border-rule shrink-0 flex flex-wrap items-center gap-3">
              <button onClick={() => setSelected(null)} className="lg:hidden btn-ghost p-2 -ml-2" aria-label="back"><ArrowLeft size={16} /></button>
              <div className="min-w-0 flex-1">
                <h2 className="text-ink font-medium truncate" title={entry?.title}>{entry?.title || selected}</h2>
                <p className="readout mt-0.5 truncate">
                  {entry?.channel_title ? `${entry.channel_title} · ` : ''}{ranked.length} clip{ranked.length === 1 ? '' : 's'}
                  {entry?.scheduled?.length > 0 && ` · ${entry.scheduled.length} scheduled on Postiz`}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {entry?.url && (
                  <a href={entry.url} target="_blank" rel="noopener noreferrer" className="btn-ghost px-3 py-2 text-xs"><ExternalLink size={14} /> original</a>
                )}
                <button onClick={zip} disabled={zipping || !ranked.length} className="btn-ghost px-3 py-2 text-xs">
                  {zipping ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} download all
                </button>
                <button onClick={deleteJob} disabled={['queued', 'processing'].includes(job?.status)} className="btn-ghost p-2" title="Delete from the server"><Trash2 size={14} /></button>
              </div>
            </div>

            {error && (
              <div className="mx-4 sm:mx-6 mt-3 px-3 py-2 rounded-input bg-paper3 text-sm text-danger flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" /> <span className="break-words">{error}</span>
              </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4 sm:p-6">
              {loadingJob ? (
                <div className="h-full flex items-center justify-center text-muted text-sm"><Loader2 size={16} className="animate-spin mr-2" /> loading clips…</div>
              ) : job?.error ? (
                <p className="text-sm text-danger">{job.error}</p>
              ) : (
                <>
                  {['queued', 'processing'].includes(job?.status) && (
                    <div className="mb-4 px-3 py-2.5 rounded-input bg-paper3 text-sm text-ink2 flex items-center gap-2">
                      <Loader2 size={14} className="animate-spin text-brass" /> Still generating — clips appear as they finish.
                    </div>
                  )}
                  {job?.status === 'failed' && !ranked.length && (
                    <p className="text-sm text-danger">This job failed: {job.error || (job.logs || []).slice(-1)[0]}</p>
                  )}
                  <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,600px),1fr))] pb-10">
                    {ranked.map(({ clip, index }) => (
                      <ResultCard
                        key={`${selected}-${index}-${clip.video_url}`}
                        clip={clip}
                        index={index}
                        jobId={selected}
                        hasGemini={!!keys.gemini_api_key}
                        hasElevenLabs={!!keys.elevenlabs_api_key}
                        channels={channels}
                        channelsError={channelsError}
                        onOpenSettings={onOpenSettings}
                        onEditClip={(i) => setEditingClip(i)}
                        onReframeClip={(i) => setReframingClip(i)}
                        onBulkSubtitle={bulkSubtitles}
                        clipCount={clips.length}
                        bulkProgress={bulkSub}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </section>

      {editingClip !== null && clips[editingClip] && (
        <ClipEditor
          jobId={selected}
          clipIndex={editingClip}
          clipTitle={clips[editingClip].video_title_for_youtube_short || ''}
          onClose={() => setEditingClip(null)}
          onRerendered={onRerendered}
        />
      )}
      {reframingClip !== null && clips[reframingClip] && (
        <ReframeEditor
          jobId={selected}
          clipIndex={reframingClip}
          clipTitle={clips[reframingClip].video_title_for_youtube_short || ''}
          onClose={() => setReframingClip(null)}
          onReframed={onRerendered}
        />
      )}
    </div>
  );
}
