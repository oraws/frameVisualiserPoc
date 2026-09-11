import { existsSync, mkdirSync, writeFileSync, readFileSync, createReadStream, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function validatePayload(data) {
  if (!['generated-gallery', 'sofa-gallery'].includes(data.roomId)) throw new Error('Choose a prepared 3D room.');
  if (!['Source colours', 'Room lighting'].includes(data.artworkColourMode)) throw new Error('Invalid colour mode.');
  if (!['None', 'Standard', 'Museum'].includes(data.glass)) throw new Error('Invalid glazing.');
  const glb = Buffer.from(data.glb || '', 'base64');
  if (glb.length < 20 || glb.length > 30 * 1024 * 1024 || glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length || glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error('Invalid or oversized frame export.');
  const length = glb.readUInt32LE(12);
  const model = JSON.parse(glb.subarray(20, 20 + length).toString());
  if ([...(model.images || []), ...(model.buffers || [])].some(x => x.uri)) throw new Error('Frame assets must be embedded.');
  return glb;
}
export default function highResRender() {
  const root = process.cwd(), jobs = new Map();
  let active;
  const blender = () => [process.env.FRAME_RENDER_BLENDER, '/Applications/Blender.app/Contents/MacOS/Blender', join(homedir(), 'Library/Application Support/Frame Visualiser/Blender.app/Contents/MacOS/Blender'), '/private/tmp/frame-room-blender/Blender.app/Contents/MacOS/Blender'].find(p => p && existsSync(p));
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const attach = server => { server.middlewares.use(async (req, res, next) => {
    const path = req.url?.split('?')[0];
    if (!path?.startsWith('/api/render')) return next();
    // Local-only service: no remote compute, arbitrary paths or executable arguments.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(res, 403, { error: 'Rendering is available on this computer only.' });
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(res, 403, { error: 'Origin mismatch.' });
    } catch { return send(res, 403, { error: 'Invalid origin.' }); }
    if (path === '/api/render' && req.method === 'GET') return send(res, 200, { available: !!blender(), busy: !!active });
    const match = path.match(/^\/api\/render\/([a-f0-9-]{36})(\/download)?$/);
    if (match && req.method === 'GET') {
      let job = jobs.get(match[1]);
      if (!job) {
        const dir = resolve(root, '.render-jobs', match[1]);
        if (existsSync(join(dir, 'final.png')) && existsSync(join(dir, 'settings.json'))) {
          try {
            const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
            job = { id: match[1], dir, roomId: settings.roomId, status: 'complete', progress: 100, message: 'Your image is ready.' };
            jobs.set(match[1], job);
          } catch {}
        }
      }
      if (!job) return send(res, 404, { error: 'Render no longer available. Please render again.' });
      if (match[2]) {
        if (job.status !== 'complete') return send(res, 409, { error: 'Render is not ready.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="${job.roomId}-3200px.png"`, 'Cache-Control': 'no-store' });
        return createReadStream(join(job.dir, 'final.png')).pipe(res);
      }
      return send(res, 200, { id: job.id, status: job.status, progress: job.progress, message: job.message });
    }
    if (path !== '/api/render' || req.method !== 'POST') return send(res, 404, { error: 'Unknown render endpoint.' });
    if (!blender()) return send(res, 503, { error: 'Install Blender in Applications, or set FRAME_RENDER_BLENDER and restart the preview.' });
    if (active) return send(res, 409, { error: 'A render is already running. Wait for it to finish.' });
    active = 'receiving';
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 42 * 1024 * 1024) throw new Error('Frame export exceeds 42 MB. Try a smaller artwork file.'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const glb = validatePayload(data), id = randomUUID(), dir = resolve(root, '.render-jobs', id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'frame.glb'), glb);
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ roomId: data.roomId, artworkColourMode: data.artworkColourMode, glass: data.glass }));
      const job = { id, dir, roomId: data.roomId, status: 'rendering', progress: 2, message: 'Preparing the full scene…' }; jobs.set(id, job); active = id;
      const child = spawn(blender(), ['--background', '--factory-startup', '--python', join(root, 'tools/high-res-render/render.py'), '--', dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const output = chunk => { log = (log + chunk.toString()).slice(-12000); const milestones = [...log.matchAll(/RENDER_PROGRESS (\d+) (.+)/g)]; if (milestones.length) { const last = milestones.at(-1); job.progress = Number(last[1]); job.message = last[2]; } };
      child.stdout.on('data', output); child.stderr.on('data', output);
      const timer = setTimeout(() => child.kill('SIGTERM'), 10 * 60 * 1000);
      child.on('error', error => { job.status = 'failed'; job.message = 'Could not start Blender: ' + error.message; active = null; clearTimeout(timer); });
      child.on('close', code => {
        clearTimeout(timer); active = null;
        writeFileSync(join(dir, 'render.log'), log);
        job.status = code === 0 && existsSync(join(dir, 'final.png')) ? 'complete' : 'failed';
        job.progress = job.status === 'complete' ? 100 : job.progress;
        job.message = job.status === 'complete' ? 'Your image is ready.' : 'Rendering failed. Check the local render log or try a smaller artwork.';
        // Keep the finished image/log; discard embedded uploads and intermediate passes.
        for (const file of ['frame.glb', 'beauty.png', 'source.png']) rmSync(join(dir, file), { force: true });
      });
      return send(res, 202, { id, status: job.status, progress: 2 });
    } catch (error) { active = null; return send(res, 400, { error: error.message || 'Invalid render request.' }); }
  });
  };
  return { name: 'local-high-res-render', configureServer: attach, configurePreviewServer: attach };
}
