import { defineConfig } from 'vite';

// GitHub Pages serves the game at https://kylersison.github.io/KYSYNC/,
// so built asset paths need that prefix (`npm run preview` uses it too).
// The dev server (`npm run dev`) still runs at the root.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/KYSYNC/' : '/',
  worker: { format: 'es' },
}));
