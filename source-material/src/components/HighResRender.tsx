import { useCallback, useEffect, useRef, useState } from 'react';

type Job = { id: string; status: string; progress: number; message?: string };
export default function HighResRender({ roomId, colourMode, glass, exporter }: {
  roomId: string; colourMode: string; glass: string; exporter: React.RefObject<(() => Promise<ArrayBuffer>) | null>;
}) {
  const [job, setJob] = useState<Job | null>(null);
  const [lastCompleted, setLastCompleted] = useState<Job | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [available, setAvailable] = useState<boolean | null>(null);
  const alive = useRef(true);
  const checkAvailability = useCallback(async () => {
    try {
      const response = await fetch('/api/render', { cache: 'no-store' });
      const data = response.ok ? await response.json() : { available: false };
      if (alive.current) setAvailable(Boolean(data.available));
      return Boolean(data.available);
    } catch {
      if (alive.current) setAvailable(false);
      return false;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    try {
      const saved = sessionStorage.getItem('high-res-render-job');
      const completed = sessionStorage.getItem('high-res-render-completed');
      if (saved) setJob(JSON.parse(saved));
      if (completed) setLastCompleted(JSON.parse(completed));
    } catch {}
    void checkAvailability();
    return () => { alive.current = false; };
  }, [checkAvailability]);
  useEffect(() => {
    if (available !== false) return;
    const retry = window.setInterval(() => void checkAvailability(), 5000);
    window.addEventListener('focus', checkAvailability);
    return () => {
      window.clearInterval(retry);
      window.removeEventListener('focus', checkAvailability);
    };
  }, [available, checkAvailability]);
  useEffect(() => {
    if (job) sessionStorage.setItem('high-res-render-job', JSON.stringify(job));
    else sessionStorage.removeItem('high-res-render-job');
    if (job?.status === 'complete') {
      setLastCompleted(job);
      sessionStorage.setItem('high-res-render-completed', JSON.stringify(job));
    }
  }, [job]);
  useEffect(() => {
    if (!job || job.status !== 'rendering') return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const response = await fetch(`/api/render/${job.id}`, { signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Render status is temporarily unavailable.');
        setError('');
        setJob(data);
      } catch (e: any) {
        if (e.name !== 'AbortError') setError(`${e.message || 'Connection lost.'} Retrying…`);
      }
    };
    const timer = window.setInterval(() => void poll(), 2000);
    void poll();
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [job?.id, job?.status]);
  async function start() {
    // Keep the last valid result visible until a replacement job is accepted.
    // Exporting a large artwork must never make the whole status area vanish.
    setPreparing(true); setError('');
    try {
      setAvailable(null);
      if (!await checkAvailability()) throw new Error('The local renderer is unavailable. Start or restart the local visualiser server, then try again.');
      if (!exporter.current) throw new Error('Wait for the artwork and frame to finish loading.');
      const buffer = await exporter.current();
      const bytes = new Uint8Array(buffer); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      const response = await fetch('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId, artworkColourMode: colourMode, glass, glb: btoa(binary) }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not start the render.');
      if (alive.current) setJob(data);
    } catch (e: any) { if (alive.current) setError(e.message || 'Could not export the frame.'); }
    finally { if (alive.current) setPreparing(false); }
  }
  const busy = preparing || job?.status === 'rendering';
  return <div className="group">
    <label>High-resolution image</label>
    <p className="room-light-note">Render this room with your current art, frame, mount and glazing. Full room composition · 3200 px longest edge · PNG.</p>
    <button type="button" onClick={start} disabled={busy} style={{ width: '100%' }}>
      {preparing ? 'Checking renderer and preparing…' : busy ? 'Rendering…' : available === false ? 'Retry high-res renderer' : 'Render high-res'}
    </button>
    {available === false && <p className="room-light-note">The local renderer is offline. The app checks again automatically; you can also restart the local server and press Retry.</p>}
    {busy && <div role="status" aria-live="polite"><progress max={100} value={preparing ? 1 : job?.progress || 1} style={{ width: '100%', marginTop: 12 }} /><p className="room-light-note">{preparing ? 'Exporting the current frame…' : job?.message || 'Preparing the scene…'} You can keep adjusting the preview; this render uses the selections captured when you clicked.</p></div>}
    {job?.status === 'complete' && !preparing && <div role="status" aria-live="polite"><progress max={100} value={100} style={{ width: '100%', marginTop: 12 }} /><p><a href={`/api/render/${job.id}/download`} download>Download high-res PNG ↗</a><span className="room-light-note" style={{ display: 'block', marginTop: 8 }}>Render complete. Later changes need a new render.</span></p></div>}
    {busy && lastCompleted && (preparing || lastCompleted.id !== job?.id) && <p><a href={`/api/render/${lastCompleted.id}/download`} download>Download previous high-res PNG ↗</a></p>}
    {(error || job?.status === 'failed') && <p role="alert" className="room-light-note">{error || job?.message}</p>}
    <p className="room-light-note">Runs on this computer. Usually takes a few minutes; keep this page open.</p>
  </div>;
}
