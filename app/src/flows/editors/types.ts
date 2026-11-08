import type { Dispatch, SetStateAction } from 'react';
import type { Lookups } from '../blocks';

export type D = Record<string, any>;

/** O que todo editor de bloco recebe. */
export interface EditorCtx {
  lookups: Lookups;
  setLookups: Dispatch<SetStateAction<Lookups>>;
  /** variáveis que os textos podem usar ({{nome}}, {{resposta}}…) */
  vars: string[];
  flowId: string;
  nodeId: string;
  /** abre "Pagamentos (produtos)" por cima do editor */
  openProducts: () => void;
  /** conexão escolhida no Início (para listar templates do número certo) */
  triggerConnectionId: string;
}

export interface EditorProps extends EditorCtx {
  d: D;
  set: (patch: D) => void;
}

/** Template aprovado como a API devolve (/templates). */
export interface Tpl {
  id: string; name: string; language: string; category: string; status: string;
  paramFormat: 'positional' | 'named';
  header: { format: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'LOCATION'; text: string | null; vars: string[]; example: string | null } | null;
  body: string; bodyVars: string[]; bodyExamples: string[]; footer: string | null;
  buttons: { type: string; text: string; url: string | null; hasVar: boolean; example: string | null }[];
}
