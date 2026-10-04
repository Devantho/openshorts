import { useEffect, useState } from 'react';
import { Key, Shield, Share2, Rocket, Lock, LogOut, Check, Loader2, AlertCircle, Trash2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiJson } from '../lib/api';
import PostizChannelPicker from './PostizChannelPicker';
import McpConnectCard from './McpConnectCard';

const KEY_FIELDS = [
  { field: 'gemini_api_key', label: 'Gemini API key', placeholder: 'AIzaSy…', help: 'Clip detection, titles, effects, thumbnails.', link: 'https://aistudio.google.com/app/apikey' },
  { field: 'elevenlabs_api_key', label: 'ElevenLabs API key', placeholder: 'sk_…', help: 'Voice dubbing and AI Shorts voices.', link: 'https://elevenlabs.io/app/settings/api-keys' },
  { field: 'fal_api_key', label: 'fal.ai API key', placeholder: 'fal_…', help: 'AI Shorts (UGC actors).', link: 'https://fal.ai/dashboard/keys' },
];

function Section({ icon, title, badge, children }) {
  const Icon = icon;
  return (
    <div className="card p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-input bg-paper3 flex items-center justify-center shrink-0">
            <Icon size={16} className="text-brass" />
          </div>
          <h2 className="text-base font-medium text-ink lowercase">{title}</h2>
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Status({ state }) {
  if (state?.ok) return <span className="badge-ok"><Check size={12} /> {state.msg}</span>;
  if (state?.error) return <span className="badge-danger"><AlertCircle size={12} /> {state.error}</span>;
  return null;
}

function KeyRow({ def, info, onSave }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);

  const save = async (next) => {
    setBusy(true);
    setState(null);
    try {
      await onSave({ [def.field]: next });
      setValue('');
      setState({ ok: true, msg: next ? 'saved' : 'removed' });
      setTimeout(() => setState(null), 2500);
    } catch (e) {
      setState({ error: e.detail || e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-sm text-ink2">{def.label}</label>
        {info?.set
          ? <span className="readout">{info.source === 'env' ? 'from .env' : 'stored on server'} · {info.hint}</span>
          : <span className="badge-warn">not set</span>}
      </div>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={info?.set ? 'enter a new key to replace it' : def.placeholder}
          className="input-field font-mono"
        />
        <button onClick={() => save(value.trim())} disabled={busy || !value.trim()} className="btn-quiet py-2 px-4 text-sm">
          {busy ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
        </button>
        {info?.source === 'server' && (
          <button onClick={() => save('')} disabled={busy} className="btn-ghost py-2 px-3 text-sm" title="Remove the stored key">
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {def.help}{' '}
          {def.link && <a href={def.link} target="_blank" rel="noopener noreferrer" className="text-brass hover:underline">get a key →</a>}
        </p>
        <Status state={state} />
      </div>
    </div>
  );
}

const Select = ({ label, value, onChange, options }) => (
  <label className="block space-y-1.5">
    <span className="eyebrow block">{label}</span>
    <select value={value} onChange={(e) => onChange(e.target.value)} className="input-field appearance-none cursor-pointer">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  </label>
);

export default function SettingsPanel({ channels, channelsError, reloadChannels }) {
  const { settings, saveSettings, logout, passwordFromEnv, postizConfigured } = useAuth();
  const keys = settings?.keys || {};

  // --- Postiz connection ---
  const [postizUrl, setPostizUrl] = useState('');
  const [postizKey, setPostizKey] = useState('');
  const [postizState, setPostizState] = useState(null);
  const [postizBusy, setPostizBusy] = useState(false);
  useEffect(() => { setPostizUrl(settings?.postiz_url || ''); }, [settings?.postiz_url]);

  const savePostiz = async () => {
    setPostizBusy(true);
    setPostizState(null);
    try {
      const changes = { postiz_url: postizUrl.trim() };
      if (postizKey.trim()) changes.postiz_api_key = postizKey.trim();
      await saveSettings(changes);
      setPostizKey('');
      // Prove the pair works right away.
      const data = await apiJson('/api/postiz/integrations');
      setPostizState({ ok: true, msg: `connected · ${data.integrations?.length || 0} channel(s)` });
      reloadChannels?.();
    } catch (e) {
      setPostizState({ error: e.detail || e.message });
      reloadChannels?.();
    } finally {
      setPostizBusy(false);
    }
  };

  // --- Publishing defaults + auto-post (edited locally, saved together) ---
  const [publish, setPublish] = useState(null);
  const [autopost, setAutopost] = useState(null);
  const [prefsState, setPrefsState] = useState(null);
  const [prefsBusy, setPrefsBusy] = useState(false);
  useEffect(() => {
    if (settings) {
      setPublish(settings.publish);
      setAutopost(settings.autopost);
    }
  }, [settings]);

  const savePrefs = async () => {
    setPrefsBusy(true);
    setPrefsState(null);
    try {
      await saveSettings({ publish, autopost });
      setPrefsState({ ok: true, msg: 'saved' });
      setTimeout(() => setPrefsState(null), 2500);
    } catch (e) {
      setPrefsState({ error: e.detail || e.message });
    } finally {
      setPrefsBusy(false);
    }
  };

  // --- Password ---
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwState, setPwState] = useState(null);
  const changePassword = async () => {
    setPwState(null);
    if (pw.next !== pw.confirm) return setPwState({ error: 'passwords do not match' });
    try {
      await apiJson('/api/auth/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: pw.current, new_password: pw.next }),
      });
      setPw({ current: '', next: '', confirm: '' });
      setPwState({ ok: true, msg: 'password changed' });
    } catch (e) {
      setPwState({ error: e.detail || e.message });
    }
  };

  if (!settings) {
    return <div className="h-full flex items-center justify-center text-muted text-sm"><Loader2 size={16} className="animate-spin mr-2" /> loading settings…</div>;
  }

  const setP = (k) => (v) => setPublish((p) => ({ ...p, [k]: v }));
  const setA = (k) => (v) => setAutopost((a) => ({ ...a, [k]: v }));

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-8 animate-fade">
      <div className="max-w-2xl mx-auto space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <p className="eyebrow mb-1.5">SETTINGS</p>
            <h1 className="font-display lowercase text-2xl text-ink">Settings</h1>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted mt-1">
            <Shield size={12} className="text-ok shrink-0" /> Keys are stored on the server only — never in this browser.
          </div>
        </div>

        <Section icon={Key} title="API keys">
          <div className="space-y-6">
            {KEY_FIELDS.map((def) => (
              <KeyRow key={def.field} def={def} info={keys[def.field]} onSave={saveSettings} />
            ))}
          </div>
        </Section>

        <Section
          icon={Share2}
          title="Postiz (publishing)"
          badge={postizConfigured ? <span className="badge-ok">configured</span> : <span className="badge-warn">not configured</span>}
        >
          <p className="text-xs text-muted mb-4 leading-relaxed">
            Clips are published through your self-hosted <strong>Postiz</strong>. Connect your YouTube, TikTok, Instagram…
            channels in Postiz, then create an API key in Postiz → Settings → Public API.
          </p>
          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="eyebrow block">POSTIZ URL</span>
              <input
                type="url"
                value={postizUrl}
                onChange={(e) => setPostizUrl(e.target.value)}
                placeholder="https://postiz.example.com"
                className="input-field font-mono"
              />
              <span className="text-xs text-muted block">The app URL, its backend URL (…/api) or the full public API URL (…/api/public/v1).</span>
            </label>
            <label className="block space-y-1.5">
              <span className="eyebrow flex items-center justify-between">
                <span>POSTIZ API KEY</span>
                {keys.postiz_api_key?.set && <span className="readout normal-case">{keys.postiz_api_key.source === 'env' ? 'from .env' : 'stored'} · {keys.postiz_api_key.hint}</span>}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={postizKey}
                onChange={(e) => setPostizKey(e.target.value)}
                placeholder={keys.postiz_api_key?.set ? 'leave empty to keep the current key' : 'your Postiz public API key'}
                className="input-field font-mono"
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button onClick={savePostiz} disabled={postizBusy || !postizUrl.trim()} className="btn-primary py-2 px-4 text-sm">
                {postizBusy ? <Loader2 size={14} className="animate-spin" /> : 'Save & test'}
              </button>
              {postizConfigured && (
                <button onClick={reloadChannels} className="btn-ghost py-2 px-3 text-sm"><RefreshCw size={14} /> reload channels</button>
              )}
              <Status state={postizState} />
            </div>
            {postizConfigured && (
              <div>
                <span className="eyebrow block mb-2">CONNECTED CHANNELS</span>
                <PostizChannelPicker channels={channels} error={channelsError} value={[]} onChange={() => {}} />
              </div>
            )}
          </div>
        </Section>

        {publish && autopost && (
          <>
            <Section icon={SlidersHorizontal} title="Publishing defaults">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select label="YOUTUBE VISIBILITY" value={publish.youtube_privacy} onChange={setP('youtube_privacy')}
                  options={[['public', 'public'], ['unlisted', 'unlisted'], ['private', 'private']]} />
                <Select label="INSTAGRAM" value={publish.instagram_post_type} onChange={setP('instagram_post_type')}
                  options={[['post', 'reel / post'], ['story', 'story']]} />
                <Select label="TIKTOK PRIVACY" value={publish.tiktok_privacy} onChange={setP('tiktok_privacy')}
                  options={[['PUBLIC_TO_EVERYONE', 'everyone'], ['MUTUAL_FOLLOW_FRIENDS', 'friends'], ['FOLLOWER_OF_CREATOR', 'followers'], ['SELF_ONLY', 'only me']]} />
                <Select label="TIKTOK METHOD" value={publish.tiktok_method} onChange={setP('tiktok_method')}
                  options={[['DIRECT_POST', 'publish directly'], ['UPLOAD', 'send to tiktok inbox (draft)']]} />
              </div>
              <label className="block space-y-1.5 mt-4">
                <span className="eyebrow block">HASHTAGS ADDED TO EVERY POST</span>
                <input type="text" value={publish.hashtags} onChange={(e) => setP('hashtags')(e.target.value)} placeholder="#shorts #podcast" className="input-field" />
              </label>
            </Section>

            <Section
              icon={Rocket}
              title="Auto-post"
              badge={
                <label className="flex items-center gap-2 text-sm text-ink2 cursor-pointer">
                  <input type="checkbox" checked={!!autopost.enabled} onChange={(e) => setA('enabled')(e.target.checked)} className="w-4 h-4 accent-brass" />
                  enabled
                </label>
              }
            >
              <p className="text-xs text-muted mb-4 leading-relaxed">
                When a clip job finishes, its best clips (highest predicted score) are sent to Postiz automatically:
                the first one after the delay below, then one every “spacing” hours.
              </p>
              <div className={`space-y-4 ${autopost.enabled ? '' : 'opacity-50'}`}>
                <div>
                  <span className="eyebrow block mb-2">CHANNELS</span>
                  {postizConfigured
                    ? <PostizChannelPicker channels={channels} error={channelsError} value={autopost.integration_ids || []} onChange={setA('integration_ids')} />
                    : <p className="text-xs text-muted">Configure Postiz above first.</p>}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <label className="block space-y-1.5">
                    <span className="eyebrow block">CLIPS / JOB</span>
                    <input type="number" min={1} max={20} value={autopost.clips_per_job} onChange={(e) => setA('clips_per_job')(Number(e.target.value))} className="input-field" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="eyebrow block">FIRST AFTER (MIN)</span>
                    <input type="number" min={0} value={autopost.first_delay_minutes} onChange={(e) => setA('first_delay_minutes')(Number(e.target.value))} className="input-field" />
                  </label>
                  <label className="block space-y-1.5">
                    <span className="eyebrow block">SPACING (H)</span>
                    <input type="number" min={0} step={0.5} value={autopost.spacing_hours} onChange={(e) => setA('spacing_hours')(Number(e.target.value))} className="input-field" />
                  </label>
                  <Select label="MODE" value={autopost.mode} onChange={setA('mode')}
                    options={[['schedule', 'schedule'], ['draft', 'draft in postiz']]} />
                </div>
              </div>
            </Section>

            <div className="flex items-center gap-3 -mt-4">
              <button onClick={savePrefs} disabled={prefsBusy} className="btn-primary py-2 px-4 text-sm">
                {prefsBusy ? <Loader2 size={14} className="animate-spin" /> : 'Save publishing settings'}
              </button>
              <Status state={prefsState} />
            </div>
          </>
        )}

        <Section icon={Lock} title="Panel password">
          {passwordFromEnv ? (
            <p className="text-xs text-muted">The password is set by <code>APP_PASSWORD</code> in the server environment. Change it there and restart.</p>
          ) : (
            <div className="space-y-3">
              <input type="password" autoComplete="current-password" placeholder="current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className="input-field" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input type="password" autoComplete="new-password" placeholder="new password (8+ chars)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className="input-field" />
                <input type="password" autoComplete="new-password" placeholder="confirm" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} className="input-field" />
              </div>
              <div className="flex items-center gap-3">
                <button onClick={changePassword} disabled={!pw.current || !pw.next} className="btn-quiet py-2 px-4 text-sm">Change password</button>
                <Status state={pwState} />
              </div>
            </div>
          )}
          <button onClick={logout} className="btn-ghost py-2 px-4 text-sm mt-4"><LogOut size={14} /> Sign out</button>
        </Section>

        <McpConnectCard />
      </div>
    </div>
  );
}
