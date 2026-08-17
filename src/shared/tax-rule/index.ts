/**
 * Barrel da peça @shared/tax-rule — consumidores importam daqui
 * (módulo tax-rules, faturamento futuro; padrão do @shared/entity).
 */
export * from './types'
export { findTaxRule, resolveMatchStateId, resolveEffectiveSt, pickRule } from './match'
export { loadPieces, savePieces, findInvalidCatalogCodes } from './pieces'
