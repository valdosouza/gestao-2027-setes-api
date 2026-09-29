import { TaxAuthority, TaxAuthorityAdapter } from '../types'
import { adnAdapter } from './adn'

const ADAPTERS: Record<TaxAuthority, TaxAuthorityAdapter> = { ADN: adnAdapter }

/** Adaptador por autoridade fiscal (amanhã: SEFAZ para a NF-e agrega chave, não reforma). */
export function adapterFor(authority: TaxAuthority): TaxAuthorityAdapter {
  const a = ADAPTERS[authority]
  if (!a) throw new Error(`Autoridade fiscal sem adaptador: ${authority}`)
  return a
}

export { adnAdapter }
