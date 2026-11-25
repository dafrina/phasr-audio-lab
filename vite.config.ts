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
    include: ['tests/**/*.test.ts'],
  },
});
