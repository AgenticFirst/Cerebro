import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    watch: {
      // Renderer Vite must only react to files that affect its own build.
      // Without this, anything else writing to disk during a session — Claude
      // Code touching .claude/, backend writes, Playwright spec edits — triggers
      // a full page reload mid-flight. That destroys long-running chats and
      // makes e2e tests flaky in ways that look like product bugs.
      ignored: [
        '**/.claude/**',
        '**/backend/**',
        '**/e2e/**',
        '**/docs/**',
        '**/test-results/**',
        '**/playwright-report/**',
        '**/.git/**',
      ],
    },
  },
});
