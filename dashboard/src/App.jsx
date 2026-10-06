import { useState, useEffect, useMemo } from 'react';
import { Sparkles, Youtube, Instagram, ChevronDown, Activity, LayoutDashboard, Settings, Plus, X, Terminal, LayoutGrid, Image, RotateCcw, Calendar, AlertTriangle, KeyRound, Loader2, Download, Menu, LogOut, Share2, Tv, Film } from 'lucide-react';
import MediaInput from './components/MediaInput';
import ResultCard from './components/ResultCard';
import ProcessingAnimation from './components/ProcessingAnimation';
import ThumbnailStudio from './components/ThumbnailStudio';
import SaaShortsTab from './components/SaaShortsTab';
import UGCGallery from './components/UGCGallery';
import ScheduleWeekModal from './components/ScheduleWeekModal';
import ClipEditor from './components/ClipEditor';
import ReframeEditor from './components/ReframeEditor';
import SettingsPanel from './components/SettingsPanel';
import ChannelsPage from './components/ChannelsPage';
import LibraryPage from './components/LibraryPage';
import Modal from './components/ui/Modal';
import { useAuth } from './contexts/AuthContext';
import { apiFetch } from './lib/api';
import { usePostizChannels } from './lib/postiz';
import { applySubtitlesToAll, downloadAllClips } from './lib/clipActions';

// Simple TikTok icon since Lucide might not have it or it varies
const TikTokIcon = ({ size = 16, className = "" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
    <path d="M19.589 6.686a4.793 4.793 0 0 1-3.77-4.245V2h-3.445v13.672a2.896 2.896 0 0 1-5.201 1.743l-.002-.001.002.001a2.895 2.895 0 0 1 3.183-4.51v-3.5a6.329 6.329 0 0 0-5.394 10.692 6.33 6.33 0 0 0 10.857-4.424V8.687a8.182 8.182 0 0 0 4.773 1.526V6.79a4.831 4.831 0 0 1-1.003-.104z" />
  </svg>
);

const formatRetention = (seconds) => {
  if (seconds >= 86400) return `${Math.round(seconds / 86400)} day${seconds >= 172800 ? 's' : ''}`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} hour${seconds >= 7200 ? 's' : ''}`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
};

// Postiz's web app for the "open postiz" links: the configured URL minus any API suffix.
const postizAppUrl = (url) => (url || '').replace(/\/api(\/public\/v1)?\/?$/, '') || null;

const SESSION_KEY = 'openshorts_session';

// The server's own explanation for a rejected/failed job, readable: FastAPI
// answers {"detail": "..."} or {"detail": {"message": ...}}.
const readableError = (raw) => {
  const text = String(raw || '').trim();
  try {
    const body = JSON.parse(text);
    const d = body?.detail ?? body;
    if (typeof d === 'string' && d) return d.slice(0, 300);
    if (d && typeof d.message === 'string') return d.message.slice(0, 300);
  } catch (_) { /* not JSON */ }
  return text.replace(/^Error:\s*/, '').slice(0, 300) || 'Something went wrong.';
};
// Matches the self-host JOB_RETENTION_SECONDS default. A restore whose job was
// already purged server-side fails gracefully and clears the saved session.
const SESSION_MAX_AGE = 86400000; // 24 hours

const pollJob = async (jobId) => {
  const res = await apiFetch(`/api/status/${jobId}`);
  if (!res.ok) throw new Error('Status check failed');
  return res.json();
};

function App() {
  const { keys, localLlm, jobRetentionSeconds, postizConfigured, settings, logout } = useAuth();
  const { channels, error: channelsError, reload: reloadChannels } = usePostizChannels(postizConfigured);

  // Why the last job could not start or failed, in plain words (or '').
  const [jobError, setJobError] = useState('');
  const [queueInfo, setQueueInfo] = useState(null);
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle, processing, complete, error
  const [results, setResults] = useState(null);
  // Best clips first. The ORIGINAL array position travels with each clip and is
  // what gets passed down as `index`: it is the clip's identity everywhere else
  // (clip_index on /api/subtitle, /api/edit and publishing, the download name).
  const rankedClips = useMemo(() => {
    const clips = results?.clips;
    if (!Array.isArray(clips)) return [];
    return clips
      .map((clip, index) => ({ clip, index }))
      .sort((a, b) => {
        const sa = Number.isFinite(a.clip?.predicted_score) ? a.clip.predicted_score : -1;
        const sb = Number.isFinite(b.clip?.predicted_score) ? b.clip.predicted_score : -1;
        return sb - sa || a.index - b.index;
      });
  }, [results]);
  // Bulk subtitles: apply one style to every clip of the job.
  const [bulkSub, setBulkSub] = useState({ running: false, current: 0, total: 0, errors: 0 });
  const [downloadingAll, setDownloadingAll] = useState(false);
  // Pre-flight quality gate: { info: {max_height, min_height, cookies_invalid}, data }
  const [qualityGate, setQualityGate] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logTimes, setLogTimes] = useState([]);
  const [logsVisible, setLogsVisible] = useState(() => {
    try { return window.innerWidth >= 768; } catch { return true; }
  });
  const [processingMedia, setProcessingMedia] = useState(null);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [navOpen, setNavOpen] = useState(false);
  const [sessionRecovered, setSessionRecovered] = useState(false);
  const [showScheduleWeek, setShowScheduleWeek] = useState(false);
  const [editingClip, setEditingClip] = useState(null);
  const [reframingClip, setReframingClip] = useState(null);

  // Sync state for original video playback
  const [syncedTime, setSyncedTime] = useState(0);
  const [isSyncedPlaying, setIsSyncedPlaying] = useState(false);
  const [syncTrigger, setSyncTrigger] = useState(0);

  const handleClipPlay = (startTime) => {
    setSyncedTime(startTime);
    setIsSyncedPlaying(true);
    setSyncTrigger(prev => prev + 1);
  };
  const handleClipPause = () => setIsSyncedPlaying(false);

  // A recut replaced the clip's server file with a fresh render (burned layers
  // reset), so update the results and let the ResultCard remount from the new file.
  const handleClipRerendered = (index, data) => {
    setResults((prev) => {
      if (!prev?.clips?.[index]) return prev;
      const clips = prev.clips.slice();
      clips[index] = { ...clips[index], video_url: data.new_video_url, start: data.start, end: data.end, recipe: data.recipe };
      return { ...prev, clips };
    });
  };

  // Apply one subtitle style to every clip of the job, sequentially.
  const handleBulkSubtitles = async (options) => {
    const clips = results?.clips || [];
    if (!clips.length) return;
    await applySubtitlesToAll(jobId, clips, options, setBulkSub);
    try {
      const data = await pollJob(jobId);
      if (data.result) setResults(data.result);
    } catch { /* keep current results */ }
  };

  const handleDownloadAll = async () => {
    if (!jobId) return;
    setDownloadingAll(true);
    try {
      await downloadAllClips(jobId);
    } catch (e) {
      alert(`Download failed: ${e.message}`);
    } finally {
      setDownloadingAll(false);
    }
  };

  // Session Recovery: Restore on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SESSION_KEY);
      if (!saved) return;
      const session = JSON.parse(saved);
      if (Date.now() - session.timestamp > SESSION_MAX_AGE) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      if (session.jobId && session.status && session.status !== 'idle') {
        setJobId(session.jobId);
        setResults(session.results || null);
        if (session.processingMedia) setProcessingMedia(session.processingMedia);
        else setProcessingMedia({ type: 'server', payload: `/api/source/${session.jobId}` });
        if (session.activeTab) setActiveTab(session.activeTab);
        setStatus(session.status === 'processing' ? 'processing' : session.status);
        setSessionRecovered(true);
        setTimeout(() => setSessionRecovered(false), 5000);
      }
    } catch (e) {
      localStorage.removeItem(SESSION_KEY);
    }
  }, []);

  // Session Recovery: Save state changes (job state only — never keys).
  useEffect(() => {
    if (status === 'idle') {
      localStorage.removeItem(SESSION_KEY);
      return;
    }
    try {
      let persistMedia = null;
      if (processingMedia?.type === 'url') persistMedia = processingMedia;
      else if (processingMedia && jobId) persistMedia = { type: 'server', payload: `/api/source/${jobId}` };
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        jobId, status, results, processingMedia: persistMedia, activeTab, timestamp: Date.now(),
      }));
    } catch (e) {
      // localStorage full or serialization error - ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, status, results, activeTab]);

  // Leftovers from the upstream build, which kept keys in the browser.
  useEffect(() => {
    ['gemini_key', 'uploadPostKey_v3', 'elevenLabsKey_v1', 'falKey_v1', 'uploadUserId'].forEach((k) => {
      try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
    });
  }, []);

  useEffect(() => {
    let interval;
    if (status === 'processing' && jobId) {
      interval = setInterval(async () => {
        try {
          const data = await pollJob(jobId);
          if (data.result) setResults(data.result);
          setQueueInfo(data.status === 'queued' && data.queue ? data.queue : null);
          if (data.logs) {
            setLogs(data.logs);
            setLogTimes(data.log_times || []);
          }
          if (data.status === 'completed') {
            setQueueInfo(null);
            setStatus('complete');
            clearInterval(interval);
          } else if (data.status === 'failed') {
            setStatus('error');
            const errorMsg = data.error || (data.logs && data.logs.length > 0 ? data.logs[data.logs.length - 1] : "Process failed");
            setJobError(readableError(errorMsg));
            setLogs(prev => [...prev, "Error: " + errorMsg]);
            clearInterval(interval);
          }
        } catch (e) {
          console.error("Polling error", e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [status, jobId]);

  // Auto-post runs after the job is marked complete: keep reading the logs a
  // little longer so its "Auto-post: ..." lines show up.
  useEffect(() => {
    if (status !== 'complete' || !jobId || !settings?.autopost?.enabled) return;
    let cancelled = false;
    (async () => {
      for (const delay of [3000, 8000, 20000, 45000]) {
        await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        try {
          const data = await pollJob(jobId);
          if (!cancelled && data.logs) { setLogs(data.logs); setLogTimes(data.log_times || []); }
        } catch { return; }
      }
    })();
    return () => { cancelled = true; };
  }, [status, jobId, settings?.autopost?.enabled]);

  // A self-hosted server running the moment picker on a local LLM
  // (LLM_BASE_URL) does not need a Gemini key for the core pipeline.
  const geminiOk = !!keys.gemini_api_key || !!localLlm;
  const keysMissing = !geminiOk;

  const handleProcess = async (data, forceLowQuality = false) => {
    if (keysMissing) {
      setShowKeyModal(true);
      return;
    }
    setStatus('processing');
    setJobError('');
    setLogs(["Starting process..."]);
    setLogTimes([Date.now() / 1000]);
    setResults(null);
    // Studio handovers have no local media object; the preview switches to the
    // backend-served source once the job id is known.
    setProcessingMedia(data.type === 'thumbnail_session' ? null : data);
    setQualityGate(null);

    try {
      let body;
      const headers = {};
      const advanced = {
        target_clips: data.targetClips || null,
        clip_min_seconds: data.clipMinSeconds || null,
        clip_max_seconds: data.clipMaxSeconds || null,
        auto_hook: data.autoHook ? '1' : '0',
        auto_hook_style: data.autoHook ? (data.autoHookStyle || 'pill') : null,
        // 'auto' is the server default, so only a deliberate choice travels.
        layouts: data.layout && data.layout !== 'auto' ? data.layout : null,
      };

      if (data.type === 'url') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          url: data.payload,
          acknowledged: !!data.acknowledged,
          output_format: data.outputFormat || 'auto',
          force_low_quality: forceLowQuality,
          ...Object.fromEntries(Object.entries(advanced).filter(([, v]) => v != null)),
        });
      } else if (data.type === 'thumbnail_session') {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({
          thumbnail_session_id: data.payload,
          acknowledged: !!data.acknowledged,
          output_format: data.outputFormat || 'auto',
          ...Object.fromEntries(Object.entries(advanced).filter(([, v]) => v != null)),
        });
      } else {
        const formData = new FormData();
        formData.append('file', data.payload);
        formData.append('acknowledged', data.acknowledged ? 'true' : 'false');
        formData.append('output_format', data.outputFormat || 'auto');
        for (const [k, v] of Object.entries(advanced)) {
          if (v != null) formData.append(k, v);
        }
        body = formData;
      }

      const res = await apiFetch('/api/process', { method: 'POST', headers, body });
      if (!res.ok) throw new Error(await res.text());
      const resData = await res.json();

      // Quality gate: the source is below the min resolution — ask first.
      if (resData.needs_confirmation) {
        setStatus('idle');
        setQualityGate({ info: resData.quality_check, data });
        return;
      }

      setJobId(resData.job_id);
      if (data.type === 'thumbnail_session') {
        setProcessingMedia({ type: 'server', payload: `/api/source/${resData.job_id}` });
      }
    } catch (e) {
      const reason = readableError(e.message);
      setJobError(reason);
      setStatus('error');
      setLogs(l => [...l, `Error starting job: ${reason}`]);
    }
  };

  const handleReset = () => {
    setStatus('idle');
    setJobId(null);
    setResults(null);
    setLogs([]);
    setLogTimes([]);
    setProcessingMedia(null);
    setQueueInfo(null);
    setJobError('');
    localStorage.removeItem(SESSION_KEY);
  };

  // --- UI Components ---

  // One nav definition drives the desktop rail, the mobile drawer, and the
  // bottom tab bar. `short` is the tab-bar label.
  const navItems = [
    { id: 'dashboard', icon: LayoutDashboard, label: 'Clip Generator', short: 'clips', primary: true },
    { id: 'library', icon: Film, label: 'Generated Clips', short: 'library', primary: true },
    { id: 'channels', icon: Tv, label: 'Channels', short: 'channels', primary: true },
    { id: 'saasshorts', icon: Sparkles, label: 'AI Shorts', short: 'ai shorts', primary: true },
    { id: 'ugc-gallery', icon: LayoutGrid, label: 'UGC Gallery', short: 'gallery' },
    { id: 'thumbnails', icon: Image, label: 'YouTube Studio', short: 'studio', primary: true },
    { id: 'settings', icon: Settings, label: 'Settings', short: 'settings' },
  ];
  const activeNav = navItems.find((n) => n.id === activeTab);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setNavOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navOpen]);

  const goToTab = (id) => {
    setActiveTab(id);
    setNavOpen(false);
  };
  const openSettings = () => goToTab('settings');

  const NavFooter = ({ collapsed = false }) => (
    <>
      {postizConfigured && postizAppUrl(settings?.postiz_url) && (
        <a
          href={postizAppUrl(settings?.postiz_url)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-3 py-2 text-xs lowercase text-muted hover:text-ink2 transition-colors"
        >
          <Share2 size={14} className="shrink-0" />
          <span className={collapsed ? 'hidden lg:block truncate' : 'truncate'}>open postiz</span>
        </a>
      )}
      <button
        onClick={logout}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs lowercase text-muted hover:text-ink2 transition-colors"
      >
        <LogOut size={14} className="shrink-0" />
        <span className={collapsed ? 'hidden lg:block truncate' : 'truncate'}>sign out</span>
      </button>
    </>
  );

  const NavButton = ({ item, compact = false }) => {
    const NavIcon = item.icon;
    const isActive = activeTab === item.id;
    return (
      <button
        onClick={() => goToTab(item.id)}
        title={item.label}
        aria-current={isActive ? 'page' : undefined}
        className={`relative w-full flex items-center gap-3 px-3 ${compact ? 'py-2.5' : 'py-3'} rounded-input transition-colors ${isActive ? 'bg-paper3 text-ink' : 'text-muted hover:text-ink2 hover:bg-paper3/50'}`}
      >
        {isActive && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-brass rounded-full" aria-hidden="true" />}
        <NavIcon size={18} className={`shrink-0 ${isActive ? 'text-brass' : ''}`} />
        <span className={`${compact ? 'text-sm hidden lg:block' : 'text-[0.95rem]'} lowercase flex-1 text-left truncate`}>{item.label}</span>
      </button>
    );
  };

  // Desktop rail: icon-only from md, labelled from lg.
  const Sidebar = () => (
    <div className="hidden md:flex w-20 lg:w-64 bg-paper2 border-r border-rule flex-col h-full shrink-0 transition-all duration-300">
      <div className="p-6 flex items-center gap-3">
        <div className="w-8 h-8 bg-paper3 rounded-input flex items-center justify-center shrink-0 overflow-hidden border border-rule">
          <img src="/logo-openshorts.png" alt="Logo" className="w-full h-full object-cover" />
        </div>
        <span className="font-display lowercase text-lg text-ink hidden lg:block">bomshort</span>
      </div>
      <nav className="flex-1 px-4 py-4 space-y-1">
        {navItems.map((item) => <NavButton key={item.id} item={item} compact />)}
      </nav>
      <div className="p-4 border-t border-rule space-y-1">
        <NavFooter collapsed />
      </div>
    </div>
  );

  const MobileNavDrawer = () => (
    <div className="md:hidden fixed inset-0 z-[90] flex" role="dialog" aria-modal="true" aria-label="Navigation">
      <div className="absolute inset-0 bg-black/60 animate-fade" onClick={() => setNavOpen(false)} aria-hidden="true" />
      <div className="relative w-[17rem] max-w-[82vw] h-full bg-paper2 border-r border-rule flex flex-col animate-slide-in-left">
        <div className="flex items-center justify-between px-5 h-14 border-b border-rule shrink-0">
          <span className="font-display lowercase text-lg text-ink">bomshort</span>
          <button onClick={() => setNavOpen(false)} aria-label="close navigation" className="p-2 -mr-2 text-muted hover:text-ink transition-colors">
            <X size={18} />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto custom-scrollbar px-3 py-3 space-y-1">
          {navItems.map((item) => <NavButton key={item.id} item={item} />)}
        </nav>
        <div className="px-3 py-3 border-t border-rule space-y-0.5 safe-bottom shrink-0">
          <NavFooter />
        </div>
      </div>
    </div>
  );

  const MobileTabBar = () => {
    const tabs = navItems.filter((n) => n.primary);
    const moreActive = !tabs.some((t) => t.id === activeTab);
    return (
      <nav className="md:hidden shrink-0 border-t border-rule bg-paper2/95 backdrop-blur-sm safe-bottom">
        <div className="flex items-stretch">
          {tabs.map((item) => {
            const NavIcon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => goToTab(item.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] transition-colors ${isActive ? 'text-ink' : 'text-muted active:text-ink2'}`}
              >
                <NavIcon size={19} className={isActive ? 'text-brass' : ''} />
                <span className="text-[10.5px] lowercase leading-none truncate max-w-full px-0.5">{item.short}</span>
              </button>
            );
          })}
          <button
            onClick={() => setNavOpen(true)}
            aria-label="more sections"
            aria-expanded={navOpen}
            className={`flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-2 min-h-[56px] transition-colors ${moreActive ? 'text-ink' : 'text-muted active:text-ink2'}`}
          >
            <Menu size={19} className={moreActive ? 'text-brass' : ''} />
            <span className="text-[10.5px] lowercase leading-none">more</span>
          </button>
        </div>
      </nav>
    );
  };

  return (
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] bg-paper overflow-hidden">
      <Sidebar />
      {navOpen && <MobileNavDrawer />}

      <main className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        {/* Top Header */}
        <header className="h-14 border-b border-rule bg-paper flex items-center justify-between gap-2 px-3 sm:px-6 shrink-0 z-10">
          <div className="flex items-center gap-2 sm:gap-4 min-w-0">
            <button
              onClick={() => setNavOpen(true)}
              aria-label="open navigation"
              className="md:hidden -ml-1 p-2 rounded-input text-muted active:bg-paper3 transition-colors shrink-0"
            >
              <Menu size={20} />
            </button>
            <span className="md:hidden font-display lowercase text-base text-ink truncate">
              {activeNav?.label || 'bomshort'}
            </span>
            {status !== 'idle' && (
              <button onClick={handleReset} className="btn-quiet px-3 py-1.5 text-xs shrink-0" aria-label="New Project">
                <Plus size={14} />
                <span className="hidden sm:inline">New Project</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 sm:gap-4 shrink-0">
            {settings?.autopost?.enabled && postizConfigured && (
              <span className="badge-brass hidden sm:inline-flex" title="Best clips of each job are sent to Postiz automatically">auto-post on</span>
            )}
            {!postizConfigured && (
              <button onClick={openSettings} className="badge-warn hover:brightness-125 transition-all hidden sm:inline-flex">
                <AlertTriangle size={12} /> <span className="hidden md:inline">Postiz not configured</span><span className="md:hidden">postiz</span>
              </button>
            )}
            {keysMissing && (
              <button onClick={openSettings} className="badge-warn hover:brightness-125 transition-all hidden sm:inline-flex">
                <AlertTriangle size={12} /> <span className="hidden md:inline">Gemini API Key Missing</span><span className="md:hidden">keys missing</span>
              </button>
            )}
          </div>
        </header>

        {/* Persistent Missing Keys Banner */}
        {keysMissing && activeTab !== 'settings' && (
          <div className="mx-3 sm:mx-6 mt-3 px-3.5 sm:px-4 py-3 bg-paper2 border border-rule rounded-card flex flex-wrap items-center justify-between gap-2.5 sm:gap-4 shrink-0 animate-fade">
            <div className="flex items-start sm:items-center gap-2.5 sm:gap-3 text-sm text-ink2 min-w-0 flex-1">
              <KeyRound size={16} className="shrink-0 text-warn mt-0.5 sm:mt-0" />
              <div className="min-w-0">
                <span className="font-medium text-ink">Gemini API key missing.</span>{' '}
                <span className="text-muted">Add it in Settings (stored on the server).</span>
              </div>
            </div>
            <button onClick={openSettings} className="btn-quiet px-3 py-1.5 text-xs shrink-0 w-full sm:w-auto">Go to Settings</button>
          </div>
        )}

        {sessionRecovered && (
          <div className="mx-3 sm:mx-6 mt-2 px-3.5 sm:px-4 py-3 bg-paper2 border border-rule rounded-card flex items-start justify-between gap-3 animate-fade shrink-0">
            <div className="flex items-start sm:items-center gap-2 text-sm text-ink2 flex-wrap min-w-0">
              <RotateCcw size={16} className="text-brass shrink-0 mt-0.5 sm:mt-0" />
              <span className="font-medium">Session recovered</span>
              <span className="text-muted text-xs">Your previous work has been restored.</span>
            </div>
            <button onClick={() => setSessionRecovered(false)} aria-label="dismiss" className="text-muted hover:text-ink transition-colors shrink-0 -m-1 p-1">
              <X size={16} />
            </button>
          </div>
        )}

        {/* Main Workspace */}
        <div className="flex-1 overflow-hidden relative">

          {activeTab === 'settings' && (
            <SettingsPanel channels={channels} channelsError={channelsError} reloadChannels={reloadChannels} />
          )}

          {activeTab === 'library' && (
            <LibraryPage
              keys={keys}
              channels={channels}
              channelsError={channelsError}
              onOpenSettings={openSettings}
            />
          )}

          {activeTab === 'channels' && (
            <ChannelsPage
              channels={channels}
              channelsError={channelsError}
              onOpenSettings={openSettings}
              postizConfigured={postizConfigured}
            />
          )}

          {activeTab === 'saasshorts' && (
            <SaaShortsTab
              hasGemini={geminiOk}
              elevenLabsKey={!!keys.elevenlabs_api_key}
              falKey={!!keys.fal_api_key}
              channels={channels}
              channelsError={channelsError}
              onOpenSettings={openSettings}
            />
          )}

          {activeTab === 'ugc-gallery' && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-fade">
              <div className="max-w-6xl mx-auto p-4 sm:p-6 md:p-8">
                <UGCGallery />
              </div>
            </div>
          )}

          {activeTab === 'thumbnails' && (
            <ThumbnailStudio
              hasGemini={!!keys.gemini_api_key}
              channels={channels}
              channelsError={channelsError}
              onOpenSettings={openSettings}
              onCreateClips={(sessionId) => {
                setActiveTab('dashboard');
                handleProcess({ type: 'thumbnail_session', payload: sessionId, acknowledged: true });
              }}
            />
          )}

          {/* View: Dashboard (Idle) */}
          {activeTab === 'dashboard' && status === 'idle' && (
            <div className="h-full overflow-y-auto custom-scrollbar animate-fade">
              <div className="min-h-full flex flex-col items-center justify-center px-4 py-5 sm:p-6">
                <div className="max-w-xl w-full text-center space-y-5 sm:space-y-8">
                  <div className="space-y-2.5 sm:space-y-4">
                    <p className="eyebrow hidden sm:block">CLIP GENERATOR</p>
                    <h1 className="font-display lowercase text-3xl sm:text-4xl md:text-5xl text-ink">Create Viral Shorts</h1>
                    <p className="text-muted text-[15px] sm:text-lg leading-snug sm:leading-normal max-w-sm sm:max-w-none mx-auto">
                      Drop your long-form video below to generate vertical clips with AI.
                    </p>
                  </div>

                  <MediaInput onProcess={handleProcess} isProcessing={status === 'processing'} />

                  <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-8 text-muted text-xs sm:text-sm">
                    <span className="flex items-center gap-2"><Youtube size={16} /> YouTube</span>
                    <span className="flex items-center gap-2"><Instagram size={16} /> Instagram</span>
                    <span className="flex items-center gap-2"><TikTokIcon size={16} /> TikTok</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* View: Processing / Results (Split View) */}
          {activeTab === 'dashboard' && (status === 'processing' || status === 'complete' || status === 'error') && (
            <div className="h-full flex flex-col md:flex-row gap-3 md:gap-4 p-3 md:p-4 overflow-y-auto md:overflow-y-hidden custom-scrollbar animate-fade">

              {/* Left Panel: Preview & Status */}
              <div className={`${status === 'complete' ? 'w-full md:w-[30%] lg:w-[25%]' : 'w-full md:w-[55%] lg:w-[60%]'} md:h-full flex flex-col shrink-0 md:shrink card p-3.5 sm:p-6 md:overflow-y-auto custom-scrollbar transition-all duration-700 ease-in-out`}>
                <div className="mb-4 sm:mb-6 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-medium text-ink lowercase flex items-center gap-2">
                    <Activity className={`text-brass ${status === 'processing' ? 'animate-pulse' : ''}`} size={18} />
                    Live Analysis
                  </h2>
                  <span className={status === 'processing' ? 'badge-brass' : status === 'complete' ? 'badge-ok' : 'badge-danger'}>
                    {status.toUpperCase()}
                  </span>
                </div>

                {status === 'processing' && queueInfo && (
                  <div className="mb-4 rounded-card border border-brass/40 bg-brass/5 px-4 py-3 text-sm">
                    <p className="text-ink">
                      {queueInfo.ahead === 0
                        ? 'You are next in line. Starting in a moment…'
                        : <>You are <b>#{queueInfo.position}</b> in line · about <b>{Math.max(1, Math.round(queueInfo.eta_seconds / 60))} min</b></>}
                    </p>
                  </div>
                )}

                {status === 'error' && jobError && (
                  <div className="mb-4 px-3 py-2.5 rounded-input bg-paper3 border border-rule text-sm text-danger break-words">{jobError}</div>
                )}

                {processingMedia && (
                  <ProcessingAnimation
                    media={processingMedia}
                    isComplete={status === 'complete'}
                    syncedTime={syncedTime}
                    isSyncedPlaying={isSyncedPlaying}
                    syncTrigger={syncTrigger}
                  />
                )}

                {status === 'processing' && (
                  <div className="sm:hidden mb-3 flex items-start gap-2 text-xs text-ink2 min-w-0">
                    <Loader2 size={14} className="animate-spin text-brass shrink-0 mt-px" />
                    <span className="min-w-0 leading-snug break-words">{logs.length ? logs[logs.length - 1] : 'starting up…'}</span>
                  </div>
                )}

                {/* Logs Terminal */}
                <div className={`bg-paper rounded-card border border-rule overflow-hidden flex flex-col transition-all duration-500 ${status === 'complete' ? `min-h-0 opacity-50 hover:opacity-100 ${logsVisible ? 'h-32' : 'h-auto'}` : `flex-1 ${logsVisible ? 'min-h-[160px] sm:min-h-[200px]' : 'min-h-0 flex-none'}`}`}>
                  <button
                    type="button"
                    onClick={() => setLogsVisible(!logsVisible)}
                    aria-expanded={logsVisible}
                    className="w-full px-3.5 sm:px-4 py-2.5 border-b border-rule flex items-center justify-between gap-2 bg-paper2 shrink-0 text-left"
                  >
                    <span className="readout flex items-center gap-2"><Terminal size={12} /> System Logs</span>
                    <span className="flex items-center gap-2 text-muted">
                      {!logsVisible && logs.length > 0 && <span className="readout normal-case">{logs.length}</span>}
                      <ChevronDown size={16} className={logsVisible ? '' : 'rotate-180'} />
                    </span>
                  </button>
                  {logsVisible && (
                    <div className="flex-1 p-3.5 sm:p-4 overflow-y-auto font-mono text-[11px] sm:text-xs space-y-1.5 custom-scrollbar text-muted break-words">
                      {logs.map((log, i) => (
                        <div key={i} className={`flex gap-2 ${log.toLowerCase().includes('error') ? 'text-danger' : 'text-muted'}`}>
                          <span className="text-muted opacity-50 shrink-0 hidden sm:inline tabular-nums">
                            {logTimes[i] ? new Date(logTimes[i] * 1000).toLocaleTimeString() : ''}
                          </span>
                          <span className="min-w-0 break-words">{log}</span>
                        </div>
                      ))}
                      {status === 'processing' && <div className="animate-pulse text-brass">_</div>}
                    </div>
                  )}
                </div>
              </div>

              {/* Right Panel: Results Grid */}
              <div className={`${status === 'complete' ? 'w-full md:w-[70%] lg:w-[75%]' : 'w-full md:w-[45%] lg:w-[40%]'} md:h-full flex flex-col shrink-0 md:shrink card p-3.5 sm:p-6 transition-all duration-700 ease-in-out`}>
                <div className="mb-4 sm:mb-6 shrink-0 space-y-3">
                  <h2 className="font-display lowercase text-lg sm:text-xl text-ink flex flex-wrap items-center gap-2">
                    <span className="mr-auto">Generated Shorts</span>
                    {results?.clips?.length > 0 && (
                      <span className="readout bg-paper3 px-2.5 py-1 rounded-full">{results.clips.length} Clips</span>
                    )}
                    {results?.cost_analysis && (
                      <span className="readout bg-paper3 px-2.5 py-1 rounded-full" title={`Input: ${results.cost_analysis.input_tokens} | Output: ${results.cost_analysis.output_tokens}`}>
                        GEMINI · ${results.cost_analysis.total_cost.toFixed(5)}
                      </span>
                    )}
                  </h2>
                  {results?.clips?.length > 0 && status === 'complete' && (
                    <div className="flex flex-col sm:flex-row sm:justify-end items-stretch sm:items-center gap-2">
                      <button onClick={handleDownloadAll} disabled={downloadingAll} className="btn-ghost px-3 py-2 text-xs" title="Download all clips as a ZIP">
                        {downloadingAll
                          ? <><Loader2 size={14} className="animate-spin" />zipping…</>
                          : <><Download size={14} />download all</>}
                      </button>
                      {results.clips.length > 1 && (
                        <button onClick={() => setShowScheduleWeek(true)} className="btn-primary px-4 py-2 text-xs">
                          <Calendar size={14} />
                          schedule week
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {status === 'complete' && results?.clips?.length > 0 && jobRetentionSeconds > 0 && (
                  <div className="mb-2 px-3 py-2.5 rounded-input bg-paper3 border border-paper3 text-sm">
                    <span className="text-ink">Clips are kept for {formatRetention(jobRetentionSeconds)}, then deleted.</span>{' '}
                    <span className="text-muted">Download or publish what you want to keep, or raise JOB_RETENTION_SECONDS in your env.</span>
                  </div>
                )}

                <div className="flex-1 overflow-y-auto custom-scrollbar p-1">
                  {results && results.clips && results.clips.length > 0 ? (
                    <div className={`grid gap-4 pb-10 ${status === 'complete' ? 'grid-cols-[repeat(auto-fill,minmax(min(100%,600px),1fr))]' : 'grid-cols-1'}`}>
                      {rankedClips.map(({ clip, index: i }) => (
                        <ResultCard
                          key={`${jobId}-${i}-${clip.video_url || ''}`}
                          clip={clip}
                          index={i}
                          jobId={jobId}
                          onEditClip={(index) => setEditingClip(index)}
                          onReframeClip={(index) => setReframingClip(index)}
                          hasGemini={!!keys.gemini_api_key}
                          hasElevenLabs={!!keys.elevenlabs_api_key}
                          channels={channels}
                          channelsError={channelsError}
                          onOpenSettings={openSettings}
                          onPlay={(time) => handleClipPlay(time)}
                          onPause={handleClipPause}
                          onBulkSubtitle={handleBulkSubtitles}
                          clipCount={results.clips.length}
                          bulkProgress={bulkSub}
                        />
                      ))}
                    </div>
                  ) : (
                    status === 'processing' ? (
                      <div className="h-full min-h-[140px] flex flex-col items-center justify-center text-muted space-y-3 text-center px-4">
                        <Loader2 size={28} className="animate-spin text-brass" />
                        <p className="text-sm lowercase">Waiting for clips...</p>
                        <p className="text-xs text-muted/80 max-w-[26ch] leading-snug">They appear here one by one as each finishes rendering.</p>
                      </div>
                    ) : status === 'error' ? (
                      <div className="h-full min-h-[120px] flex flex-col items-center justify-center text-danger space-y-2">
                        <p>Generation failed.</p>
                      </div>
                    ) : null
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <MobileTabBar />
      </main>

      {/* Missing API Key Modal */}
      <Modal
        isOpen={showKeyModal}
        onClose={() => setShowKeyModal(false)}
        eyebrow="SETUP"
        title="Gemini API Key Required"
        footer={
          <div className="flex gap-3">
            <button onClick={() => setShowKeyModal(false)} className="btn-ghost flex-1 px-4 py-2 text-sm">Cancel</button>
            <button onClick={() => { setShowKeyModal(false); openSettings(); }} className="btn-primary flex-1 px-4 py-2 text-sm">Go to Settings</button>
          </div>
        }
      >
        <p className="text-sm text-muted">
          The clip generator needs a <strong className="text-ink2">Gemini</strong> API key (free tier available at{' '}
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-brass underline">aistudio.google.com</a>).
          Add it in Settings: it is stored on the server, never in this browser.
        </p>
      </Modal>

      <ScheduleWeekModal
        isOpen={showScheduleWeek}
        onClose={() => setShowScheduleWeek(false)}
        clips={results?.clips || []}
        jobId={jobId}
        channels={channels}
        channelsError={channelsError}
        postizAppUrl={postizAppUrl(settings?.postiz_url)}
      />

      {/* Pre-flight quality gate */}
      {qualityGate && (
        <Modal isOpen={true} onClose={() => setQualityGate(null)} size="md" eyebrow="HEADS UP" title="low source quality">
          <div className="space-y-4">
            <p className="text-sm text-ink2">
              YouTube only offers <span className="text-brass font-semibold">{qualityGate.info.max_height}p</span> for this video
              (below the {qualityGate.info.min_height}p we recommend). Processing anyway will produce lower-quality clips.
            </p>
            {qualityGate.info.cookies_invalid && (
              <p className="text-xs text-muted">
                Your YouTube cookies look expired — refreshing them (export again from an incognito window) often unlocks HD.
              </p>
            )}
            <div className="flex gap-2 justify-end pt-2">
              <button onClick={() => setQualityGate(null)} className="btn-ghost">cancel</button>
              <button onClick={() => { const d = qualityGate.data; setQualityGate(null); handleProcess(d, true); }} className="btn-primary">
                process anyway
              </button>
            </div>
          </div>
        </Modal>
      )}

      {editingClip !== null && results?.clips?.[editingClip] && (
        <ClipEditor
          jobId={jobId}
          clipIndex={editingClip}
          clipTitle={results.clips[editingClip].video_title_for_youtube_short || ''}
          onClose={() => setEditingClip(null)}
          onRerendered={handleClipRerendered}
        />
      )}
      {reframingClip !== null && results?.clips?.[reframingClip] && (
        <ReframeEditor
          jobId={jobId}
          clipIndex={reframingClip}
          clipTitle={results.clips[reframingClip].video_title_for_youtube_short || ''}
          onClose={() => setReframingClip(null)}
          onReframed={handleClipRerendered}
        />
      )}
    </div>
  );
}

export default App;
