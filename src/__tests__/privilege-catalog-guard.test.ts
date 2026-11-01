/// <reference types="jest" />
// D-PV15 (= Q-PV17 (a), Valdo 2026-10-18) + D-PV42 (= Q-PV50 (a), Valdo 2026-10-20): as telas do Super Interfaces e Privilégios RECUSAM
// (409, nomeando o consumidor) a mudança que recriaria o C1 na hora — o boot só via no próximo restart. Integridade do catálogo, não
// autorização: vale também para o super (A-PV14). A guarda lê o MESMO conjunto da cerca e do boot (lista à mão ∪ tabela do roteador —
// D-PV14) + as REGRAS (VISUALIZAR em toda tela, CONFIGURAR com config/campo) + os reservados (D-PV51); e congela TODA chave que o código
// usa para abrir ou montar uma tela — a `i18n_key` existente não se renomeia (D-PV42).
jest.mock('../shared/db/connection', () => ({ __esModule: true, default: { query: jest.fn(), getConnection: jest.fn(), on: jest.fn(), end: jest.fn() } }))
jest.mock('../modules/interfaces/interfaces.repository', () => ({
  getInterface: jest.fn(), updateInterface: jest.fn(), insertInterface: jest.fn(), deleteInterface: jest.fn(),
  syncInterfacePrivileges: jest.fn(), liveInterfaceIdsWithKey: jest.fn(), interfaceHasConfigOrField: jest.fn(),
  INTERFACE_SEARCH_CRITERIA: [],
}))
jest.mock('../modules/privileges/privileges.repository', () => ({
  getPrivilege: jest.fn(), updatePrivilege: jest.fn(), insertPrivilege: jest.fn(), deletePrivilege: jest.fn(),
  PRIVILEGE_SEARCH_CRITERIA: [],
}))

import router from '../gateway/router'
import * as ifaceRepo from '../modules/interfaces/interfaces.repository'
import * as privRepo from '../modules/privileges/privileges.repository'
import { createInterface, editInterface, removeInterface } from '../modules/interfaces/interfaces.service'
import { createPrivilege, editPrivilege, removePrivilege } from '../modules/privileges/privileges.service'
import {
  requiredPairsOf, isMenuScreen, isScreen, interfaceCatalogViolations, privilegeCatalogViolations, assertNoCatalogViolation,
  privilegeConsumersOf, interfaceKeyUses, consumedPrivileges, RESERVED_PRIVILEGES, InterfaceCatalogState, InterfaceRules,
} from '../shared/auth/privilege-catalog'
import { HttpError } from '../shared/errors/http-error'
import { interfaceDto } from '../modules/interfaces/interfaces.dto'

void router                                                     // montar o gateway registra as guardas (a tabela da D-PV14)

const m = <T extends (...a: any[]) => any>(f: T) => f as unknown as jest.Mock
beforeEach(() => {
  jest.clearAllMocks()
  m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([])
  m(ifaceRepo.insertInterface).mockResolvedValue(41)
  m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValue(false)
})

/** settlements como fica no catálogo depois dos seeds 64 + 68 (1, 2, 3, 6, 8, 11). */
const SETTLEMENTS: InterfaceCatalogState = {
  i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', privilegeIds: [1, 2, 3, 6, 8, 11], configurable: true,
}
/** Uma interface que NENHUM código usa (sem rota no app, sem config/campo, sem par operado). */
const UNUSED: InterfaceCatalogState = { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [6] }
const pairs = (k: string | null, rules: InterfaceRules) => requiredPairsOf(k, rules).map(r => r.privilege).sort()

describe('D-PV15/D-PV51 — o que o catálogo não pode perder (peça pura)', () => {
  it('tela = kind T (qualquer grupo — o menu do super também pede VISUALIZAR); tela do menu do CLIENTE = T fora do grupo Super', () => {
    expect([isScreen('T'), isScreen(null), isScreen('t'), isScreen('R')]).toEqual([true, true, true, false])
    expect([isMenuScreen('T', 'Financeiro'), isMenuScreen(null, null), isMenuScreen('t', 'Cadastros')]).toEqual([true, true, true])
    expect([isMenuScreen('R', 'Cadastros'), isMenuScreen('T', 'Super'), isMenuScreen('T', 'super ')]).toEqual([false, false, false])
  })

  it('pares exigidos = os que o código opera (roteador + lista à mão, sem os ausentes) + VISUALIZAR se tela + CONFIGURAR da regra + reservados', () => {
    expect(pairs('settlements', { screen: true })).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
    // CANCELAR/TRANSMITIR/CONSULTAR da devolução: ausentes por decisão (A-PV12)
    expect(pairs('order-returns', { screen: true })).toEqual(['ALTERAR', 'CONFIGURAR', 'EXCLUIR', 'FATURAR', 'INSERIR', 'VISUALIZAR'])
    expect(pairs('legacy-report', { screen: false })).toEqual([])                     // ninguém usa
    expect(pairs('legacy-report', { screen: true })).toEqual(['VISUALIZAR'])           // a regra do menu
    expect(pairs('legacy-report', { screen: false, configurable: true })).toEqual(['CONFIGURAR'])   // a regra do CONFIGURAR
    expect(pairs('general-configs', { screen: true })).toEqual(['CONFIGURAR', 'VISUALIZAR'])        // sempre tem CONFIGURAR (D-PV25)
    expect(pairs('Settlements ', { screen: false })).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
    expect(pairs(null, { screen: true })).toEqual(['VISUALIZAR'])
    // reservado por decisão (D-PV3/A-PV3): também não sai
    const inst = requiredPairsOf('institutions', { screen: true, configurable: true })
    for (const r of RESERVED_PRIVILEGES.filter(x => x.interface === 'institutions')) {
      expect(inst.find(p => p.privilege === r.privilege)?.by).toMatch(/^reservado: D-PV3/)
    }
  })

  it('quem consome um privilégio pelo NOME (app e view — D-PV53)', () => {
    expect(privilegeConsumersOf(2).some(c => c.includes('trocar a cobrança'))).toBe(true)
    expect(privilegeConsumersOf(6).some(c => c.startsWith('menu'))).toBe(true)
    expect(privilegeConsumersOf(11).some(c => c.startsWith('regra do CONFIGURAR'))).toBe(true)
    expect(privilegeConsumersOf(4).length).toBeGreaterThan(0)                        // IMPRIMIR: o PDF do boleto (roteador + app)
    expect(privilegeConsumersOf(10)).toEqual([])                                    // CATALOGAR: reservado no vocabulário, sem consumidor aqui
  })

  it('a chave congelada pelo código (D-PV42): rota do app, config/campo, Configurações Gerais, pares operados, reservados', () => {
    expect(interfaceKeyUses('customers', false).some(u => u.includes('/home/customers/'))).toBe(true)
    expect(interfaceKeyUses('general-configs', false).some(u => u.includes('Configurações Gerais'))).toBe(true)
    expect(interfaceKeyUses('legacy-report', true)).toEqual(['configurações/campos do catálogo presos à chave'])
    expect(interfaceKeyUses('legacy-report', false)).toEqual([])
    expect(interfaceKeyUses('institutions', false).some(u => u.startsWith('reservados por decisão'))).toBe(true)
    expect(interfaceKeyUses(null, true)).toEqual([])
  })

  it('tirar o ALTERAR de Baixas recria o C1 → recusa nomeando o "trocar a cobrança"', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [1, 3, 6, 8, 11] })
    expect(v.map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(v[0].message).toContain('ALTERAR (2)')
    expect(v[0].message).toContain('trocar a cobrança')
  })

  it('o PUT sem privilegeIds (zera os vínculos) recusa cada par exigido', () => {
    const v = interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, privilegeIds: [] })
    expect(v.map(x => x.message.split(' ')[0]).sort()).toEqual(['ALTERAR', 'CONFIGURAR', 'DESCONTO', 'EXCLUIR', 'INSERIR', 'VISUALIZAR'])
  })

  it('tirar privilégio que ninguém opera passa (um IMPRIMIR que sobrasse em Baixas)', () => {
    const extra = { ...SETTLEMENTS, privilegeIds: [1, 2, 3, 4, 6, 8, 11] }
    expect(interfaceCatalogViolations(extra, SETTLEMENTS)).toEqual([])
  })

  it('D-PV42: a chave de interface EXISTENTE não se renomeia — nem a usada (só caixa, acento, espaço) nem a sem uso; a 1ª chave pode', () => {
    for (const k of ['baixas', 'SETTLEMENTS', 'Settlements', 'settlements ', 'séttlements', null]) {
      expect([k, interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: k }).map(x => x.code)])
        .toEqual([k, ['INTERFACE_KEY_IN_USE']])
    }
    const unused = interfaceCatalogViolations(UNUSED, { ...UNUSED, i18nKey: 'legacy-reports' })
    expect(unused.map(x => `${x.code}:${x.field}`)).toEqual(['INTERFACE_KEY_IN_USE:i18nKey'])
    expect(unused[0].message).toContain('não se renomeia (D-PV42)')
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS })).toEqual([])
    expect(interfaceCatalogViolations({ ...UNUSED, i18nKey: null }, { ...UNUSED, i18nKey: 'legacy-report' })).toEqual([])
  })

  it('tela do menu do cliente que o código usa (inclusive só pela rota do app) não vira recurso (R) nem vai ao grupo Super', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, kind: 'R' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:kind'])
    expect(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, groupDefault: 'Súper ' }).map(x => `${x.code}:${x.field}`))
      .toEqual(['INTERFACE_KEY_IN_USE:groupDefault'])
    const customers: InterfaceCatalogState = { i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6, 11] }
    expect(interfaceCatalogViolations(customers, { ...customers, groupDefault: 'Super' }).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    expect(interfaceCatalogViolations(UNUSED, { ...UNUSED, groupDefault: 'Super' })).toEqual([])   // o código não usa: pode ir ao Super
  })

  it('o DTO só aceita a chave na forma da rota (D-PV42: começa por letra; minúsculas, dígitos e hífen)', () => {
    const ok = (k: string | null) => interfaceDto.safeParse({ description: 'x', i18nKey: k }).success
    expect([ok('bank-slips'), ok('settlements'), ok('a1-b2'), ok(null)]).toEqual([true, true, true, true])
    expect([ok('Settlements'), ok('settlements '), ok('séttlements'), ok('cashier_v2'), ok('-x'), ok('x--y'), ok(''), ok('2fa'), ok('x-')])
      .toEqual([false, false, false, false, false, false, false, false, false])
  })

  it('excluir interface que o código usa recusa (par, rota do app ou config/campo); a que ninguém usa sai', () => {
    expect(interfaceCatalogViolations(SETTLEMENTS, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    const customers: InterfaceCatalogState = { i18nKey: 'customers', kind: 'T', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }
    expect(interfaceCatalogViolations(customers, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])   // a rota do app (D-PV42)
    expect(interfaceCatalogViolations({ ...UNUSED, configurable: true }, null).map(x => x.code)).toEqual(['INTERFACE_KEY_IN_USE'])
    expect(interfaceCatalogViolations(UNUSED, null)).toEqual([])
  })

  it('tela nova nasce com VISUALIZAR (D-GE19) — inclusive no grupo Super (o menu do super também a filtra); recurso R, não', () => {
    const novo = (kind: string, group: string, ids: number[]) =>
      interfaceCatalogViolations(null, { i18nKey: 'merchandise', kind, groupDefault: group, privilegeIds: ids }).map(x => x.code)
    expect(novo('T', 'Cadastros', [1, 2, 3])).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(novo('T', 'Cadastros', [6])).toEqual([])
    expect(novo('R', 'Cadastros', [])).toEqual([])
    expect(novo('T', 'Super', [])).toEqual(['CATALOG_PAIR_IN_USE'])
  })

  it('virar R → T sem VISUALIZAR recusa (a tela entraria no menu sem poder ser concedida)', () => {
    const r: InterfaceCatalogState = { i18nKey: 'partnerships', kind: 'R', groupDefault: 'Cadastros', privilegeIds: [2, 6, 11], configurable: true }
    expect(interfaceCatalogViolations(r, { ...r, kind: 'T' })).toEqual([])          // a aba já tem VISUALIZAR (a guarda por roteador o pede)
    const bare: InterfaceCatalogState = { ...UNUSED, kind: 'R', privilegeIds: [2] }
    expect(interfaceCatalogViolations(bare, { ...bare, kind: 'T' }).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
  })

  it('privilégio consumido pelo NOME EXATO (A-PV26): renomear recusa — nem a caixa muda; excluir recusa', () => {
    expect(privilegeCatalogViolations(2, 'EDITAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(2, ' ALTERAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(2, 'ALTERAR ').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])   // PAD SPACE: a view o tira
    expect(privilegeCatalogViolations(2, 'Alterar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])    // a view compara binário
    expect(privilegeCatalogViolations(2, 'ALTERAR')).toEqual([])
    expect(privilegeCatalogViolations(6, null).map(x => x.field)).toEqual(['id'])
    expect(privilegeCatalogViolations(11, 'AJUSTAR').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])    // CONFIGURAR: a regra o consome
    expect(privilegeCatalogViolations(12, null).map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])         // CONSULTAR (D-PV40)
  })

  it('privilégio que ninguém consome (CATALOGAR aqui) se renomeia — mas não com o nome de um consumido', () => {
    expect(privilegeCatalogViolations(10, 'CATALOGO CENTRAL')).toEqual([])
    expect(privilegeCatalogViolations(10, 'cancelar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'Faturar').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, ' FATURAR ').map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
    expect(privilegeCatalogViolations(null, 'AUTORIZAR')).toEqual([])
  })

  it('a guarda lê o MESMO conjunto da cerca e do boot (par novo na lista passa a ser protegido sem código novo)', () => {
    const extra = [...consumedPrivileges(), { interface: 'legacy-report', privilege: 'IMPRIMIR' as const, consumers: ['app' as const], where: 'sonda' }]
    const s: InterfaceCatalogState = { ...UNUSED, privilegeIds: [4, 6] }
    expect(interfaceCatalogViolations(s, { ...s, privilegeIds: [6] }, extra).map(x => x.code)).toEqual(['CATALOG_PAIR_IN_USE'])
    expect(privilegeCatalogViolations(10, 'X', [{ interface: 'legacy-report', privilege: 'CATALOGAR', consumers: ['app'], where: 'sonda' }])
      .map(x => x.code)).toEqual(['PRIVILEGE_IN_USE'])
  })

  it('409 com TODAS as violações em fields[]; o código é o da mais grave; a mensagem não vira um livro', () => {
    let err: HttpError | null = null
    try {
      assertNoCatalogViolation(interfaceCatalogViolations(SETTLEMENTS, { ...SETTLEMENTS, i18nKey: 'baixas', privilegeIds: [] }))
    } catch (e) { err = e as HttpError }
    expect(err?.statusCode).toBe(409)
    expect(err?.code).toBe('INTERFACE_KEY_IN_USE')
    expect(err?.fields?.length).toBeGreaterThan(1)
    expect(() => assertNoCatalogViolation([])).not.toThrow()
    const renamed = privilegeCatalogViolations(2, 'EDITAR')[0].message
    expect(renamed.length).toBeLessThan(1200)                                         // o roteador põe dezenas de rotas por verbo
  })
})

describe('D-PV15/D-PV42 — as telas do Super recusam ANTES de gravar', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 21, description: 'Baixas', position: null, ...SETTLEMENTS, ...over })

  it('Interfaces: tirar o ALTERAR de Baixas → 409 e nada é gravado', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas' }, [1, 3, 6, 8, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).not.toHaveBeenCalled()
  })

  it('Interfaces: editar mantendo os pares grava', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21])          // ela mesma
    await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas e estornos' }, [1, 2, 3, 6, 8, 11])
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    expect(ifaceRepo.syncInterfacePrivileges).toHaveBeenCalledWith(21, [1, 2, 3, 6, 8, 11])
  })

  it('Interfaces: tirar o CONFIGURAR de uma interface com config/campo → 409 (a REGRA lida do banco pela linha)', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6, 11] }))
    m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValue(true)
    await expect(editInterface(70, { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    expect(ifaceRepo.interfaceHasConfigOrField).toHaveBeenCalledWith(70)
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: renomear a chave (mesmo sem uso) → 409 sem gravar (D-PV42); dar a 1ª chave grava', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6] }))
    await expect(editInterface(70, { i18nKey: 'legacy-reports', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 71, i18nKey: null, privilegeIds: [6] }))
    await editInterface(71, { i18nKey: 'legacy-report', kind: 'T', groupDefault: 'Cadastros', description: 'x' }, [6])
    expect(ifaceRepo.updateInterface).toHaveBeenCalled()
  })

  it('Interfaces: chave REPETIDA em outra interface viva → 409 (a resolução por chave pegaria uma só)', async () => {
    m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21])
    await expect(createInterface({ i18nKey: 'settlements', kind: 'R', description: 'cópia' }, [1, 2, 3, 6, 8, 11]))
      .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.insertInterface).not.toHaveBeenCalled()
  })

  it('Interfaces: tela nova do menu sem VISUALIZAR → 409; com ele, cria', async () => {
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1]))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATALOG_PAIR_IN_USE' })
    await expect(createInterface({ i18nKey: 'merchandise', kind: 'T', groupDefault: 'Cadastros', description: 'Mercadorias' }, [1, 2, 3, 6]))
      .resolves.toEqual({ id: 41 })
  })

  it('Interfaces: excluir a que o código usa (par, rota do app, config/campo) → 409; a que ninguém usa sai', async () => {
    m(ifaceRepo.getInterface).mockResolvedValue(row())
    await expect(removeInterface(21)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 9, i18nKey: 'customers', groupDefault: 'Cadastros', privilegeIds: [1, 2, 3, 6] }))
    await expect(removeInterface(9)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    m(ifaceRepo.getInterface).mockResolvedValue(row({ id: 70, i18nKey: 'legacy-report', privilegeIds: [6] }))
    m(ifaceRepo.interfaceHasConfigOrField).mockResolvedValueOnce(true)
    await expect(removeInterface(70)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
    expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    await removeInterface(70)
    expect(ifaceRepo.deleteInterface).toHaveBeenCalledWith(70)
  })

  describe('conserto de DUPLICATA (gate socrático do delta da D-PV15: sem isso, duas linhas com a mesma chave usada só saíam por SQL)', () => {
    const FULL = [1, 2, 3, 6, 8, 11]
    const twin = (id: number, ids: number[]) => row({ id, privilegeIds: ids })
    const byId = (rows: Record<number, unknown>) => m(ifaceRepo.getInterface).mockImplementation(async (id: number) => rows[id] ?? null)

    it('excluir a duplicata sai quando a OUTRA linha viva fica com a chave e os pares', async () => {
      byId({ 21: twin(21, FULL), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await removeInterface(50)
      expect(ifaceRepo.deleteInterface).toHaveBeenCalledWith(50)
    })

    it('excluir recusa se a outra linha não é EQUIVALENTE: chave só parecida, fora do menu, ou sem o VISUALIZAR (re-prova adversarial)', async () => {
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([28, 99])
      for (const other of [
        { ...twin(99, FULL), i18nKey: 'Settlements' },                                     // chave só igual pela colação
        { ...twin(99, [1, 2, 3, 8, 11]), kind: 'R', groupDefault: 'Super' },               // recurso do Super com os pares do código
        twin(99, [1, 2, 3, 8, 11]),                                                         // tela do menu sem VISUALIZAR
      ]) {
        byId({ 28: twin(28, FULL), 99: other })
        await expect(removeInterface(28)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      }
      expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    })

    it('excluir recusa se a outra linha NÃO tem os pares que o código exige', async () => {
      byId({ 21: twin(21, [6]), 50: twin(50, FULL) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await expect(removeInterface(50)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    })

    it('excluir recusa se a linha que sai segura as configs/campos e a outra não (D-PV42: elas são presas à linha)', async () => {
      byId({ 21: twin(21, FULL), 50: twin(50, FULL) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      m(ifaceRepo.interfaceHasConfigOrField).mockImplementation(async (id: number) => id === 50)
      await expect(removeInterface(50)).rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      expect(ifaceRepo.deleteInterface).not.toHaveBeenCalled()
    })

    it('trocar a chave da duplicata NÃO é mais conserto (D-PV42: a chave não se renomeia — a duplicata sai por exclusão)', async () => {
      byId({ 21: twin(21, FULL), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockImplementation(async (k: string) => (k === 'settlements' ? [21, 50] : []))
      await expect(editInterface(50, { i18nKey: 'settlements-antiga', kind: 'R', groupDefault: 'Financeiro', description: 'sobra' }, []))
        .rejects.toMatchObject({ statusCode: 409, code: 'INTERFACE_KEY_IN_USE' })
      expect(ifaceRepo.updateInterface).not.toHaveBeenCalled()
    })

    it('editar só a descrição de uma linha de duplicata existente não esbarra na chave repetida (não piora nada)', async () => {
      byId({ 21: twin(21, FULL), 50: twin(50, [2, 6, 8]) })
      m(ifaceRepo.liveInterfaceIdsWithKey).mockResolvedValue([21, 50])
      await editInterface(21, { i18nKey: 'settlements', kind: 'T', groupDefault: 'Financeiro', description: 'Baixas (nova)' }, FULL)
      expect(ifaceRepo.updateInterface).toHaveBeenCalled()
    })
  })

  it('Privilégios: renomear ALTERAR → 409 sem gravar; CATALOGAR (sem consumidor aqui) se renomeia; excluir VISUALIZAR → 409', async () => {
    m(privRepo.getPrivilege).mockResolvedValue({ id: 2, description: 'ALTERAR' })
    await expect(editPrivilege(2, 'Alterar dados')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.updatePrivilege).not.toHaveBeenCalled()
    m(privRepo.getPrivilege).mockResolvedValue({ id: 10, description: 'CATALOGAR' })
    await editPrivilege(10, 'CATALOGO CENTRAL')
    expect(privRepo.updatePrivilege).toHaveBeenCalledWith(10, 'CATALOGO CENTRAL')
    m(privRepo.getPrivilege).mockResolvedValue({ id: 6, description: 'VISUALIZAR' })
    await expect(removePrivilege(6)).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.deletePrivilege).not.toHaveBeenCalled()
  })

  it('Privilégios: criar outro "Faturar" → 409 sem gravar', async () => {
    await expect(createPrivilege('Faturar')).rejects.toMatchObject({ statusCode: 409, code: 'PRIVILEGE_IN_USE' })
    expect(privRepo.insertPrivilege).not.toHaveBeenCalled()
  })
})
