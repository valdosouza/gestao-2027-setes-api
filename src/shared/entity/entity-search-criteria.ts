import type { SearchCriterion } from '@shared/list'
import { PERSON_TYPES } from './entity-fiscal'

/**
 * PESQUISA AVANÇADA — critérios COMUNS a todo PAPEL da cadeia de entidade
 * (customers, carriers, collaborators, providers, salesmen, institutions):
 * prompt_pesquisa_avancada.md, Onda 2 (§12, D-BA20/D-BA21).
 *
 * A cadeia (tb_entity / tb_person / tb_company / tb_address) é UMA só; o que
 * muda por papel é o alias da tabela do papel na query base. Cada módulo
 * continua DECLARANDO a sua lista branca no repository (D-BA12) — este helper
 * só evita cinco cópias da mesma expressão. As regras da forma são as da peça:
 * expressão sobre outra tabela = subselect correlacionado pela PK (1 valor por
 * linha, sem JOIN que duplicaria o COUNT); o operador é da peça pelo kind.
 *
 * @param moduleKey chave i18n do módulo (`search.<moduleKey>.<key>`)
 * @param alias     alias da tabela do papel na query base (PK = tb_entity.id)
 * @param entity    alias de setes_central.tb_entity já juntada (nick_trade/name_company)
 */
export function entityRoleSearchCriteria(
  moduleKey: string, alias: string, entity = 'e'
): SearchCriterion[] {
  if (RESERVED_ALIASES.has(alias) || RESERVED_ALIASES.has(entity)) {
    throw new Error(`entityRoleSearchCriteria: alias "${alias}"/"${entity}" colide com os aliases internos dos subselects`)
  }
  // Aliases INTERNOS com prefixo próprio (achado do EXPLAIN de 2026-10-03: `tb_provider p`
  // × `tb_person p` fazia `p.id = p.id` casar a tabela inteira — "Subquery returns more
  // than 1 row"). Nenhuma query base usa esses nomes (RESERVED_ALIASES).
  const personCpf   = `(SELECT esp.cpf FROM setes_central.tb_person esp WHERE esp.id = ${alias}.id AND esp.deleted = 'N')`
  const companyCnpj = `(SELECT esc.cnpj FROM setes_central.tb_company esc WHERE esc.id = ${alias}.id AND esc.deleted = 'N')`
  return [
    // D-BA21 (Valdo 2026-10-03): o NOME que o usuário digitaria está sempre no painel
    { key: 'name', kind: 'text', labelKey: `search.${moduleKey}.name`,
      expr: [`${entity}.nick_trade`, `${entity}.name_company`] },
    { key: 'document', kind: 'text', digits: true, labelKey: `search.${moduleKey}.document`,
      expr: [personCpf, companyCnpj] },
    // D-BA16: casa com QUALQUER endereço principal (GROUP_CONCAT das cidades main='S')
    { key: 'city', kind: 'text', labelKey: `search.${moduleKey}.city`,
      expr: `(SELECT GROUP_CONCAT(esci.name SEPARATOR ' | ') FROM setes_central.tb_address esa
                INNER JOIN setes_central.tb_city esci ON esci.id = esa.tb_city_id
               WHERE esa.id = ${alias}.id AND esa.main = 'S' AND esa.deleted = 'N')` },
    { key: 'personType', kind: 'options', labelKey: `search.${moduleKey}.personType`,
      options: PERSON_TYPES,
      expr: `(CASE WHEN EXISTS (SELECT 1 FROM setes_central.tb_person esp WHERE esp.id = ${alias}.id AND esp.deleted = 'N') THEN 'F'
                   WHEN EXISTS (SELECT 1 FROM setes_central.tb_company esc WHERE esc.id = ${alias}.id AND esc.deleted = 'N') THEN 'J'
                   ELSE 'N' END)` },
  ]
}

/** Aliases usados DENTRO dos subselects do helper — nenhuma query base pode usá-los. */
export const RESERVED_ALIASES: ReadonlySet<string> = new Set(['esp', 'esc', 'esa', 'esci'])

/** Critérios do PAPEL em si (colunas da tabela do papel): ativo + data de cadastro (DATETIME = instante, Q-BA14). */
export function roleStatusSearchCriteria(moduleKey: string, alias: string): SearchCriterion[] {
  return [
    { key: 'active', kind: 'bool', labelKey: `search.${moduleKey}.active`,
      expr: `${alias}.active`, boolValues: ['S', 'N'] },
    { key: 'createdAt', kind: 'date', labelKey: `search.${moduleKey}.createdAt`,
      expr: `${alias}.created_at`, storage: 'datetime' },
  ]
}
