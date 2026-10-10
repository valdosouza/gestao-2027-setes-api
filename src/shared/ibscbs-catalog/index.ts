/**
 * Barrel @shared/ibscbs-catalog — carga do catálogo IBS/CBS em setes_central
 * (fase IBS/CBS, IB-1 — Infra-IA/prompts/prompt_fase_ibs_cbs.md §10.5/§11).
 * Quem chama: scripts/load-ibscbs-catalog.ts (rotina do Super).
 */
export * from './parse'
export * from './reconcile'
export * from './apply'
export * from './plan'
