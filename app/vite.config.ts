import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
      // a landing (arquivo estático) recebe o mesmo endereço oficial para o redirecionamento
      const site = resolve(outDir, 'site', 'index.html');
      if (existsSync(site)) writeFileSync(site, readFileSync(site, 'utf8').replace('__CANONICAL_ORIGIN__', process.env.VITE_CANONICAL_ORIGIN ?? ''));
    },
  };
}

export default defineConfig({
  plugins: [react(), spaFallback()],
  server: { port: 5173 },
});
