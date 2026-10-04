import { useCallback, useEffect, useState } from 'react';
import { apiJson } from './api';

/**
 * Postiz channels for the publish pickers.
 * channels: undefined while loading, null when Postiz is not configured,
 * otherwise the array from GET /api/postiz/integrations.
 */
export function usePostizChannels(configured) {
  const [channels, setChannels] = useState(undefined);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!configured) { setChannels(null); setError(''); return; }
    setChannels(undefined);
    setError('');
    try {
      const data = await apiJson('/api/postiz/integrations');
      setChannels(data.integrations || []);
    } catch (e) {
      setChannels([]);
      setError(e.detail || e.message || 'Could not load Postiz channels.');
    }
  }, [configured]);

  useEffect(() => { reload(); }, [reload]);

  return { channels, error, reload };
}
