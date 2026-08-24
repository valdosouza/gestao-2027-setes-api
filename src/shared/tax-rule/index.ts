/**
 * Barrel da peça @shared/tax-rule — consumidores importam daqui
 * (módulo tax-rules, faturamento futuro; padrão do @shared/entity).
 */
export * from './types'
export { findTaxRule, resolveMatchStateId, resolveEffectiveSt, pickRule } from './match'
export {
  loadPieces, savePieces, findInvalidCatalogCodes, findInvalidSelectorRefs,
} from './pieces'
export {
  calcMerchandiseValue, prorateWithResidue,
  icmsIpiIntegratesBase, calcBaseIcms, calcBaseIcmsSt, calcIcms, calcIcmsCsosn,
  calcFcpProprio, calcFcpSt,
  calcIpi, calcPisCofins, calcIi, calcIssqn,
  calculateItemTaxes,
} from './calc'
