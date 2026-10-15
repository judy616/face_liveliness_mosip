import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 3000,
    open: false,
  },
  optimizeDeps: {
    include: ['@mediapipe/tasks-vision'],
  },
});
