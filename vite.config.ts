import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // GitHub Pages serves the app from /<repo>/; set BASE_PATH there (see .github/workflows/pages.yml)
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  worker: {
    // AudioWorklet modules must be self-contained; iife bundles inline all imports.
    format: 'iife',
  },
  test: {
    environment: 'node',
    // `npm run test:perf` (PERF=1) runs only the slower allocation-budget tests; `npm test` everything else
    include: process.env.PERF ? ['tests/**/*.perf.test.ts'] : ['tests/**/*.test.ts'],
    exclude: process.env.PERF ? [] : ['tests/**/*.perf.test.ts'],
  },
});
