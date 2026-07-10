import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';

function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin\b/g, '');
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, 'src/desktop/renderer'),
  base: './',
  plugins: [removeCrossorigin()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
});
