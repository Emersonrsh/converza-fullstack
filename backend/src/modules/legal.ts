/**
 * Termos de Uso, Política de Privacidade e Exclusão de dados: os textos ficam no app (páginas públicas);
 * a API só entrega os dados da empresa (variáveis LEGAL_*), para trocar sem refazer o site.
 */
import { Router } from 'express';
import { config } from '../config';
import { formatTaxId, normTaxId, taxIdKind } from '../billing/rules';

/** Versão dos textos aceita no cadastro (mude quando os Termos ou a Política mudarem). */
export const TERMS_VERSION = '2026-11-08';

export const legalRouter = Router();

legalRouter.get('/legal', (_req, res) => {
  const l = config.legal;
  // LEGAL_CNPJ aceita CNPJ (inclusive o novo, com letras) ou CPF, para quem vende como pessoa física
  const kind = l.cnpj ? taxIdKind(l.cnpj) : null;
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    version: TERMS_VERSION,
    company: {
      tradeName: l.tradeName, companyName: l.companyName || null,
      cnpj: l.cnpj ? (kind ? formatTaxId(normTaxId(l.cnpj)) : l.cnpj) : null,
      docType: kind ?? (l.cnpj ? 'cnpj' : null),
      address: l.address || null,
      email: l.email || null, dpoName: l.dpoName || null, dpoEmail: l.dpoEmail || l.email || null, city: l.city || null,
    },
    // a página avisa o operador do que falta preencher (ou corrigir) no Render
    missing: (['companyName', 'cnpj', 'address', 'email', 'city'] as const).filter((k) => !l[k]),
    invalid: l.cnpj && !kind ? ['cnpj'] : [],
    qrCode: config.waWeb.enabled,
  });
});
