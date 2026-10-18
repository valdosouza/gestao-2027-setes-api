/// <reference types="jest" />
// Gate adversarial da D-PV2 (HIGH, 2026-10-18 — prompt_privilegios_interfaces.md §11, Q-PV28 — interino): o próprio
// estabelecimento não se cadastra como papel; senão a aba Tributação do papel reescreve a linha do EMITENTE em tb_entity_tax
// (o que a nfse-api lê para o DPS) e a cadeia dele, por fora do Meu Estabelecimento.
import fs from 'fs'
import path from 'path'
import { assertNotOwnEstablishment } from '../shared/entity'

describe('assertNotOwnEstablishment', () => {
  it('entity = institution → 409 ROLE_IS_OWN_ESTABLISHMENT ancorado no CNPJ', () => {
    expect(() => assertNotOwnEstablishment(7, 7)).toThrow(expect.objectContaining({
      statusCode: 409, code: 'ROLE_IS_OWN_ESTABLISHMENT', fields: [expect.objectContaining({ field: 'cnpj' })],
    }))
  })
  it('qualquer outra entity passa', () => {
    expect(() => assertNotOwnEstablishment(8, 7)).not.toThrow()
  })
})

describe('cerca: os 4 papéis com cadeia fiscal chamam a barreira na CRIAÇÃO (depois do reuso pelo documento) e na EDIÇÃO', () => {
  it.each([['customers', 'Customer'], ['providers', 'Provider'], ['carriers', 'Carrier'], ['collaborators', 'Collaborator']])(
    '%s', (m, fn) => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'modules', m, `${m}.repository.ts`), 'utf8')
      const body = (name: string) => {
        const i = src.indexOf(`export async function ${name}(`)
        expect([name, i >= 0]).toEqual([name, true])
        const j = src.indexOf('\nexport ', i + 1)
        return src.slice(i, j < 0 ? undefined : j)
      }
      const create = body(`insert${fn}Cascade`)
      expect(create).toMatch(/saveEntityFiscalChain\(conn, null[^\n]*\n\s*assertNotOwnEstablishment\(id, institutionId\)/)
      const update = body(`update${fn}Cascade`)
      expect(update.indexOf('assertNotOwnEstablishment(id, institutionId)')).toBeGreaterThan(-1)
      expect(update.indexOf('assertNotOwnEstablishment(id, institutionId)'))
        .toBeLessThan(update.indexOf('saveEntityFiscalChain(conn, id'))
    })
})
