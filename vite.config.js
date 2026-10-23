import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from https://ruralroster.github.io/district-roster/
export default defineConfig({
  plugins: [react()],
  base: '/district-roster/',
});
