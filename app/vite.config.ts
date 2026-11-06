import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Hospedagens estáticas (como o Render) servem o 404.html quando a rota não
 * existe como arquivo. Copiando o index.html para 404.html, atualizar a página
 * em /flows/123 (ou qualquer rota) abre o app normalmente, mesmo sem configurar
 * regra de rewrite no painel.
 */
function spaFallback(): Plugin {
  let outDir = 'dist';
  return {
    name: 'converza-spa-fallback',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const index = resolve(outDir, 'index.html');
      if (existsSync(index)) copyFileSync(index, resolve(outDir, '404.html'));
    },
  };
}

export default defineConfig({
  plugins: [react(), spaFallback()],
  server: { port: 5173 },
});
