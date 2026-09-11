import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import highResRender from './tools/high-res-render/plugin.mjs';
import mouldingMaterialReview from './tools/moulding-material-pilot/plugin.mjs';

export default defineConfig({
  integrations: [react()],
  // Several local previews may run alongside a production build. Vite's
  // optimiser rewrites dependency exports, so each process needs its own cache.
  vite: { plugins: [highResRender(), mouldingMaterialReview()], cacheDir: `node_modules/.vite/visualiser-${process.pid}` },
});
