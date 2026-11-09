import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// One build, four apps (multi-page): ERP desktop + Driver / Warehouse / Customer mobile PWAs.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        erp: resolve(__dirname, 'erp.html'),
        driver: resolve(__dirname, 'driver.html'),
        warehouse: resolve(__dirname, 'warehouse.html'),
        customer: resolve(__dirname, 'customer.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
