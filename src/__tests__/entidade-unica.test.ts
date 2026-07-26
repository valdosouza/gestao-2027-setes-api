/// <reference types="jest" />
// Fase 3 — Entidade Única (prompt_fase3_entidade_unica.md): buscar-antes-de-
// criar com reuso por documento (decisões 1 e 9), toggle triplo F/J/N
// (decisões 4 e 5) e conflito de documento na edição/upgrade (decisão 6).
import { PoolConnection } from 'mysql2/promise'
import * as entityRepo from '../shared/entity/entity.repository'
import * as fiscalRepo from '../shared/fiscal/fiscal.repository'
import * as addressRepo from '../shared/address/address.repository'
import * as phoneRepo from '../shared/phone/phone.repository'
import * as socialRepo from '../shared/social-media/social-media.repository'
import { saveEntityFiscalChain, EntityFiscalInput } from '../shared/entity'

jest.mock('../shared/entity/entity.repository')
jest.mock('../shared/fiscal/fiscal.repository')
jest.mock('../shared/address/address.repository')
jest.mock('../shared/phone/phone.repository')
jest.mock('../shared/social-media/social-media.repository')

const mockNextId       = entityRepo.nextEntityId       as jest.Mock
const mockInsertEntity = entityRepo.insertEntity       as jest.Mock
const mockUpdateEntity = entityRepo.updateEntity       as jest.Mock
const mockUpsertFiscal = fiscalRepo.upsertFiscal       as jest.Mock
const mockByCpf        = fiscalRepo.findEntityIdByCpf  as jest.Mock
const mockByCnpj       = fiscalRepo.findEntityIdByCnpj as jest.Mock
const mockSyncAddr     = addressRepo.syncAddresses     as jest.Mock
const mockSyncPhone    = phoneRepo.syncPhones          as jest.Mock
const mockSyncSocial   = socialRepo.syncSocialMedia    as jest.Mock

const conn = {} as PoolConnection

const baseInput = (over: Partial<EntityFiscalInput>): EntityFiscalInput => ({
  entity:      { nameCompany: 'F.D. Souza - Setes', nickTrade: 'Setes' },
  personType:  'J',
  company:     { cnpj: '07742094000113' },
  addresses:   [],
  phones:      [],
  socialMedia: [],
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockByCpf.mockResolvedValue(null)
  mockByCnpj.mockResolvedValue(null)
  mockNextId.mockResolvedValue(10)
})

describe('saveEntityFiscalChain — criação (id null)', () => {
  it('CNPJ inédito: cria entity nova (MAX+1) — comportamento original preservado', async () => {
    const result = await saveEntityFiscalChain(conn, null, baseInput({}), 7)

    expect(result).toEqual({ id: 10, reused: false })
    expect(mockByCnpj).toHaveBeenCalledWith('07742094000113', conn, true) // lock na transação
    expect(mockInsertEntity).toHaveBeenCalledWith(conn, 10, expect.anything(), 7)
    expect(mockUpdateEntity).not.toHaveBeenCalled()
  })

  it('CNPJ conhecido: REUSA o id e atualiza a cadeia (last-write-wins, decisão 1)', async () => {
    mockByCnpj.mockResolvedValue(1) // entity 1 = Setes

    const result = await saveEntityFiscalChain(conn, null, baseInput({}), 7)

    expect(result).toEqual({ id: 1, reused: true })
    expect(mockInsertEntity).not.toHaveBeenCalled()
    expect(mockNextId).not.toHaveBeenCalled()
    expect(mockUpdateEntity).toHaveBeenCalledWith(conn, 1, expect.anything(), 7)
    expect(mockUpsertFiscal).toHaveBeenCalledWith(conn, 1, expect.anything(), 7)
    expect(mockSyncAddr).toHaveBeenCalled()
    expect(mockSyncPhone).toHaveBeenCalled()
    expect(mockSyncSocial).toHaveBeenCalled()
  })

  it('CPF conhecido: mesmo reuso para pessoa física', async () => {
    mockByCpf.mockResolvedValue(4)
    const input = baseInput({ personType: 'F', person: { cpf: '52998224725' }, company: null })

    const result = await saveEntityFiscalChain(conn, null, input)

    expect(result).toEqual({ id: 4, reused: true })
    expect(mockByCpf).toHaveBeenCalledWith('52998224725', conn, true)
  })

  it('listas AUSENTES (undefined) não tocam no banco — proteção pós-E2E 2026-07-15', async () => {
    mockByCnpj.mockResolvedValue(1)
    const input = baseInput({})
    delete (input as any).addresses
    delete (input as any).phones
    delete (input as any).socialMedia

    await saveEntityFiscalChain(conn, null, input)

    expect(mockSyncAddr).not.toHaveBeenCalled()
    expect(mockSyncPhone).not.toHaveBeenCalled()
    expect(mockSyncSocial).not.toHaveBeenCalled()
  })

  it('lista [] EXPLÍCITA continua limpando (comportamento deliberado)', async () => {
    mockByCnpj.mockResolvedValue(1)

    await saveEntityFiscalChain(conn, null, baseInput({ addresses: [] }))

    expect(mockSyncAddr).toHaveBeenCalledWith(conn, 1, [], null)
  })

  it("personType 'N' (sem documento): NUNCA deduplica — id novo direto (decisão 5)", async () => {
    const input = baseInput({ personType: 'N', person: null, company: null })

    const result = await saveEntityFiscalChain(conn, null, input)

    expect(result).toEqual({ id: 10, reused: false })
    expect(mockByCpf).not.toHaveBeenCalled()
    expect(mockByCnpj).not.toHaveBeenCalled()
    expect(mockUpsertFiscal).toHaveBeenCalledWith(conn, 10,
      expect.objectContaining({ personType: 'N' }), null)
  })
})

describe('saveEntityFiscalChain — edição (id informado)', () => {
  it('doc da própria entity: atualiza normalmente', async () => {
    mockByCnpj.mockResolvedValue(5)

    const result = await saveEntityFiscalChain(conn, 5, baseInput({}), 9)

    expect(result).toEqual({ id: 5, reused: false })
    expect(mockUpdateEntity).toHaveBeenCalledWith(conn, 5, expect.anything(), 9)
  })

  it('doc pertence a OUTRA entity → 409 por campo (decisão 6 — sem merge)', async () => {
    mockByCnpj.mockResolvedValue(1) // dono é a entity 1, editando a 5

    await expect(saveEntityFiscalChain(conn, 5, baseInput({})))
      .rejects.toMatchObject({
        statusCode: 409,
        fields: [{ field: 'cnpj', message: expect.stringContaining('já cadastrado') }],
      })
    expect(mockUpdateEntity).not.toHaveBeenCalled()
  })

  it('upgrade N→F com CPF inédito: permitido (decisão 6)', async () => {
    const input = baseInput({ personType: 'F', person: { cpf: '52998224725' }, company: null })

    const result = await saveEntityFiscalChain(conn, 8, input)

    expect(result).toEqual({ id: 8, reused: false })
    expect(mockUpsertFiscal).toHaveBeenCalledWith(conn, 8,
      expect.objectContaining({ personType: 'F' }), null)
  })
})
