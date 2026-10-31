/// <reference types="jest" />
// D-PV15 (= Q-PV17 (a), Valdo 2026-10-18): as telas do Super Interfaces e Privilégios RECUSAM (409, nomeando o consumidor) a mudança
// que recriaria o C1 na hora — o boot só via no próximo restart. Integridade do catálogo, não autorização: vale também para o super.
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn() } }))
jest.mock('../modules/interfaces/interfaces.repository', () => ({
  getInterface: jest.fn(), updateInterface: jest.fn(), insertInterface: jest.fn(), deleteInterface: jest.fn(),
  syncInterfacePrivileges: jest.fn(), liveInterfaceIdsWithKey: jest.fn(), INTERFACE_SEARCH_CRITERIA: [],
}))
jest.mock('../modules/privileges/privileges.repository', () => ({
  getPrivilege: jest.fn(), updatePrivilege: jest.fn(), insertPrivilege: jest.fn(), deletePrivilege: jest.fn(),
  PRIVILEGE_SEARCH_CRITERIA: [],
}))

import * as ifaceRepo from '../modules/interfaces/interfaces.repository'
import * as privRepo from '../modules/privileges/privileges.repository'
import { createInterface, editInterface, removeInterface } from '../modules/interfaces/interfaces.service'
import { createPrivilege, editPrivilege, removePrivilege } from '../modules/privileges/privileges.service'
import {
  requiredPairsOf, isMenuScreen, interfaceCatalogViolations, privilegeCatalogViolations, assertNoCatalogViolation,
  privilegeConsumersOf, CONSUMED_PRIVILEGES, InterfaceCatalogState,
} from '../shared/auth/privilege-catalog'
import { HttpError } from '../shared/errors/http-error'
import { interfaceDto } from '../modules/interfaces/interfaces.dto'

const m = <T extends (...a: any[]) => any>(f: T) => f as unknown as jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([])
  m(ifaceRepo.insertInterface).mockResolvedValue(41)
})

/** settlements como está no catálogo depois do seed 64 (1, 2, 3, 6, 8). */
const SETTLEMENTS: InterfaceCatalogState = { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', privilegeIds: [1, 2, 3, 6, 8] }
const pairs = (k: string | null, menu: boolean) => requiredPairsOf(k, menu).map(r => r.privilege).sort()

describe('D-PV15 — o que o catálogo não pode perder (peça pura)', () => {
  it('tela do menu do cliente = kind T fora do grupo Super, comparado como o banco (sem caixa, sem espaço no fim)', () => {
    expect([isMenuScreen('T', 'Financeiro'), isMenuScreen(null, null), isMenuScreen('t', 'Cadastros')]).toEqual([true, true, true])
    expect([isMenuScreen('R', 'Cadastros'), isMenuScreen('T', 'Super'), isMenuScreen('T', 'super ')]).toEqual([false, false, false])
  })

  it('pares exigidos = os que o código consome (sem os ausentes por decisão) + VISUALIZAR se vai ao menu', () => {
    expect(pairs('settlements', true)).toEqual(['ALTERAR', 'DESCONTO', 'VISUALIZAR'])
    expect(pairs('order-returns', true)).toEqual(['FATURAR', 'VISUALIZAR'])   // CANCELAR/TRANSMITIR ausentes (A-PV12)
    expect(pairs('cfop', false)).toEqual([])                                   // tela do Super, o código não usa
    expect(pairs('Settlements ', false)).toEqual(['ALTERAR', 'DESCONTO'])      // a chave como o banco compara
    expect(pairs(null, true)).toEqual(['VISUALIZAR'])
  })

  it('quem consome um privilégio pelo NOME', () => {
    expect(privilegeConsumersOf(2).some(c => c.includes('trocar a cobrança'))).toBe(true)
    expect(privilegeConsumersOf(6)).toEqual([expect.stringContaining('menu do usuário regular')])
    expect(privilegeConsumersOf(4)).toEqual([])                                 // IMPRIMIR: nenhum código consome hoje
  })

  it('tirar o ALTERAR de Baixas recria o C1 → recusa nomeando o "trocar a cobrança"', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [1, 3, 6, 8] })
    expect(v.map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(v[0].message).toContain('ALTERAR (2)')
    expect(v[0].message).toContain('trocar a cobrança')
  })

  it('o PUT sem privilegeIds (zera os vínculos) recusa cada par exigido', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [] })
    expect(v.map(x => x.message.split(' ')[0]).sort()).toEqual(['ALTERAR', 'DESCONTO', 'VISUALIZAR'])
  })

  it('tirar privilégio que ninguém consome passa (INSERIR/EXCLUIR de Baixas hoje)', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [2, 6, 8] })).toEqual([])
  })

  it('trocar a chave de interface que o código usa recusa — INCLUSIVE só caixa, acento, espaço no fim ou sem chave (o app procura a rota EXATA)', () => {
    for (const k of ['baixas', 'SETTLEMENTS', 'Settlements', 'settlements ', 'séttlements', null]) {
      expect([k, interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: k }).map(x => x.code)])
        .toEqual([k, ['INTERFACE_KEY_IN_USE']])
    }
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS })).toEqual([])
  })

  it('tela do menu que o código usa não vira recurso (R) nem vai ao grupo Super (o botão ficaria inalcançável)', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, kind: 'R' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:kind'])
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, groupDefault: 'Súper ' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:groupDefault'])
    const cfop: InterfaceCatalogState = { i18nKey: 'cfop', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }
    expect(interfaceCatalogViolations(cfop, { ...cfop, groupDefault: 'Super' })).toEqual([])   // o código não usa: pode ir ao Super
  })

  it('o DTO só aceita a chave na forma canônica (a das rotas do app e do boot)', () => {
    const ok = (k: string | null) => interfaceDto.safeParse({ description: 'x', i18nKey: k }).success
    expect([ok('bank-slips'), ok('settlements'), ok('a1-b2'), ok(null)]).toEqual([true, true, true, true])
    expect([ok('Settlements'), ok('settlements '), ok('séttlements'), ok('cashier_v2'), ok('-x'), ok('x--y'), ok('')])
      .toEqual([false, false, false, false, false, false, false])
  })

  it('excluir interface que o código usa recusa; a que ninguém usa sai', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    expect(interfaceCatalogViolations({ i18nKey: 'cfop', kind: 'T', groupDefault: 'Super', privilegeIds: [1, 2, 3, 6] }, null)).toEqual([])
    expect(interfaceCatalogViolations({ i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }, null)).toEqual([])
  })

  it('tela nova do menu nasce com VISUALIZAR (D-GE19); recurso R e tela do Super, não', () => {
    const novo = (kind: string, group: string, ids: number[]) =>
      interfaceCatalogViolations(null, { i18nKey: 'merchandise', kind, groupDefault: group, privilegeIds: ids }).map(x => x.code)
    expect(novo('T', 'Cadastros', [1, 2, 3])).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(novo('T', 'Cadastros', [6])).toEqual([])
    expect(novo('R', 'Cadastros', [])).toEqual([])
    expect(novo('T', 'Super', [])).toEqual([])
  })

  it('virar R → T sem VISUALIZAR recusa (a tela entraria no menu sem poder ser concedida)', () => {
    const r: InterfaceCatalogState = { i18nKey: 'partnerships', kind: 'R', groupDefault: 'Cadastros', privilegeIds: [2] }
    expect(interfaceCatalogViolations(r, { ...r, kind: 'T' }).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
  })

  it('privilégio consumido pelo NOME: renomear recusa (só a caixa pode mudar); excluir recusa', () => {
    expect(privilegeCatalogViolations(2, 'EDITAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(2, ' ALTERAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])   // o app não faz trim
    expect(privilegeCatalogViolations(2, 'Alterar')).toEqual([])
    expect(privilegeCatalogViolations(6, null).map(x => x.field)).toEqual(['id'])
  })

  it('privilégio que ninguém consome (IMPRIMIR hoje) se renomeia — mas não com o nome de um consumido', () => {
    expect(privilegeCatalogViolations(4, 'IMPRESSÃO')).toEqual([])
    expect(privilegeCatalogViolations(4, 'cancelar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'Faturar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'AUTORIZAR')).toEqual([])
  })

  it('a guarda lê a MESMA lista da cerca e do boot (par novo na lista passa a ser protegido sem código novo)', () => {
    const extra = [...CONSUMED_PRIVILEGES, { interface: 'customers', privilege: 'INSERIR' as const, consumers: ['app' as const], where: 'fábrica' }]
    const c: InterfaceCatalogState = { i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }
    expect(interfaceCatalogViolations(c, { ...c, privilegeIds: [2, 3, 6] }, extra).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(privilegeCatalogViolations(1, 'INCLUIR', extra).map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
  })

  it('409 com TODAS as violações em fields[]; o código é o da mais grave', () => {
    let err: HttpError | null = null
    try {
      assertNoCatalogViolation(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: 'baixas', privilegeIds: [] }))
    } catch (e) { err = e as HttpError }
    expect(err?.statusCode).toBe(409)
    expect(err?.code).toBe('INTERFACE_KEY_IN_USE')
    expect(err?.fields?.length).toBeGreaterThan(1)
    expect(() => assertNoCatalogViolation([])).not.toThrow()
  })
})

describe('D-PV15 — as telas do Super recusam ANTES de gravar', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 21, description: 'Baixas', position: null, ...SETTLEMENTS, ...over })

  it('Interfaces: tirar o ALTERAR de Baixas → 409 e nada é gravado', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas' }, [1, 3, 6, 8]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).not.toHaveBeenCalled()
  })

  it('Interfaces: editar mantendo os pares grava', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21])          // ela mesma
    await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas e estornos' }, [2, 6, 8])
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).toHaveBeenCalledWith(21, [2, 6, 8])
  })

  it('Interfaces: chave REPETIDA em outra interface viva → 409 (a guarda resolveria por LIMIT 1)', async () => {
    m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21])
    await expect(createInterface({ i18nKey: 'Settlements', kind: 'R', description: 'cópia' }, []))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.insertInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: tela nova do menu sem VISUALIZAR → 409; com ele, cria', async () => {
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1, 2, 3, 6]))
      .resolves.toEqual({ id: 41 })
  })

  it('Interfaces: excluir a que o código usa → 409; a outra sai', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(removeInterface(21)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 15, i18nKey: 'cfop', groupDefault: 'Super' }))
    await removeInterface(15)
    expect(ifaceRepo.deleteInterface).toHaveBeenCalledWith(15)
  })

  describe('conserto de DUPLICATA (gate socrático do delta: sem isso, duas linhas com a mesma chave consumida só saíam por SQL)', () => {
    const twin = (id: number, ids: number[]) => row({ id, privilegeIds: ids })
    const byId = (rows: Record<number, unknown>) => m(ifaceRepo.getInterface).mockImplementation(async (id: number) => rows[id] ?? null)

    it('excluir a duplicata sai quando a OUTRA linha viva fica com a chave e os pares', async () => {
      byId({ 21: twin(21, [1, 2, 3, 6, 8]), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await removeInterface(50)
      expect(ifaceRepo.deleteInterface).toHaveBeenCalledWith(50)
    })

    it('excluir recusa se a outra linha não é EQUIVALENTE: chave só parecida, fora do menu, ou sem o VISUALIZAR (re-prova adversarial)', async () => {
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([28, 99])
      for (const other of [
        { ...twin(99, [1, 2, 3, 6, 8]), i18nKey: 'Settlements' },   // chave só igual pela colação
        { ...twin(99, [2, 8]), kind: 'R', groupDefault: 'Super' },                            // recurso do Super com os pares do código
        twin(99, [2, 8]),                                                                      // tela do menu sem VISUALIZAR
      ]) {
        byId({ 28: twin(28, [1, 2, 3, 6, 8]), 99: other })
        await expect(removeInterface(28)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      }
      expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    })

    it('excluir recusa se a outra linha NÃO tem os pares que o código exige', async () => {
      byId({ 21: twin(21, [6]), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await expect(removeInterface(50)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    })

    it('trocar a chave da duplicata passa quando a outra fica com a chave e os pares', async () => {
      byId({ 21: twin(21, [1, 2, 3, 6, 8]), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockImplementation(async (k: string) => (k === 'settlements' ? [21, 50] : []))
      await editInterface(50, { i18nKey: 'settlements-antiga', kind: 'R', groupDefault: 'Financeiro', description: 'sobra' }, [])
      expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    })

    it('editar só a descrição de uma linha de duplicata existente não esbarra na chave repetida (não piora nada)', async () => {
      byId({ 21: twin(21, [1, 2, 3, 6, 8]), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas (nova)' }, [1, 2, 3, 6, 8])
      expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    })
  })

  it('Privilégios: renomear ALTERAR → 409 sem gravar; IMPRIMIR se renomeia; excluir VISUALIZAR → 409', async () => {
    m(privRepo.getPrivilege).mockResolvedValue({ id: 2, description: 'ALTERAR' })
    await expect(editPrivilege(2, 'Alterar dados')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.updatePrivilege).not.toHaveBeenCalled()
    m(privRepo.getPrivilege).mockResolvedValue({ id: 4, description: 'IMPRIMIR' })
    await editPrivilege(4, 'IMPRESSÃO')
    expect(privRepo.updatePrivilege).toHaveBeenCalledWith(4, 'IMPRESSÃO')
    m(privRepo.getPrivilege).mockResolvedValue({ id: 6, description: 'VISUALIZAR' })
    await expect(removePrivilege(6)).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.deletePrivilege).not.toHaveBeenCalled()
  })

  it('Privilégios: criar outro "Faturar" → 409 sem gravar', async () => {
    await expect(createPrivilege('Faturar')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.insertPrivilege).not.toHaveBeenCalled()
  })
})
