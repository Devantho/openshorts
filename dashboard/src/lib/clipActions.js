// Job-wide clip actions shared by the Clip Generator and the Clips library.
import { apiFetch } from './api';

// Apply one subtitle style to every clip of a job, sequentially.
// onProgress({running, current, total, errors}) is called as it goes.
export async function applySubtitlesToAll(jobId, clips, options, onProgress = () => {}) {
  const total = clips.length;
  let errors = 0;
  onProgress({ running: true, current: 0, total, errors });
  for (let i = 0; i < total; i++) {
    onProgress({ running: true, current: i + 1, total, errors });
    try {
      const res = await apiFetch('/api/subtitle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          job_id: jobId,
          clip_index: i,
          position: options.position,
          font_size: options.fontSize,
          font_name: options.fontName,
          font_color: options.fontColor,
          border_color: options.borderColor,
          border_width: options.borderWidth,
          bg_color: options.bgColor,
          bg_opacity: options.bgOpacity,
          style: options.style || 'pill',
          highlight_color: options.highlightColor || '#FFD700',
          effect: options.effect || 'none',
          base_opacity: options.baseOpacity ?? 1.0,
          uppercase: options.uppercase || false,
          reveal: options.reveal || false,
          shadow: options.shadow || 0,
          max_chars: options.maxChars ?? null,
          max_duration: options.maxDuration ?? null,
          // Chain from the clip's current server file (its video_url basename).
          input_filename: (clips[i].video_url || '').split('/').pop(),
        }),
      });
      if (!res.ok) errors++;
    } catch {
      errors++;
    }
  }
  onProgress({ running: false, current: total, total, errors });
  return errors;
}

// Download every clip of a job as one ZIP.
export async function downloadAllClips(jobId, name) {
  const res = await apiFetch(`/api/jobs/${jobId}/download-all`);
  if (!res.ok) throw new Error(await res.text());
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name || `clips_${(jobId || '').slice(0, 8)}`}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
