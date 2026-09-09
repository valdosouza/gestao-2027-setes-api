/// <reference types="jest" />
// Pedido de Venda/Conjugado (2026-08-22) — tela de processo: backbone
// tb_order + ramo tb_order_sale SEMPRE; tb_order_service nasce por
// PRESENÇA (1º item de serviço). Faturamento é do módulo billing.
import pool from '../shared/db/connection'
import {
  createOrder, createItem, editItem, deleteItem, removeOrder, fetchOrder,
} from '../modules/orders/orders.service'

jest.mock('../shared/db/connection', () => ({
  __esModule: true,
  default: { query: jest.fn(), getConnection: jest.fn() },
}))

const mockQuery = (pool as any).query as jest.Mock
const scope = { schemaName: 'setes_setes', institutionId: 1, userId: 7 }

beforeEach(() => jest.clearAllMocks())

function fakeConn() {
  return {
    beginTransaction: jest.fn(), query: jest.fn(),
    commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
  }
}

describe('createOrder (openOrder)', () => {
  it('vendedor explícito: abre tb_order + tb_order_sale', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([{}])                       // Q-A12: lock da institution (1º)
      .mockResolvedValueOnce([[{ salesmanId: null }]]) // cliente existe, sem vendedor padrão
      .mockResolvedValueOnce([[{ nextId: 10 }]])
      .mockResolvedValueOnce([[{ nextNumber: 1 }]])
      .mockResolvedValueOnce([{}]) // insert tb_order
      .mockResolvedValueOnce([{}]) // insert tb_order_sale

    const id = await createOrder({ customerId: 5, salesmanId: 9 }, scope)
    expect(id).toBe(10)
    expect(conn.commit).toHaveBeenCalled()
    const saleInsert = conn.query.mock.calls[5]
    expect(saleInsert[1]).toContain(9) // salesmanId gravado
  })

  it('sem vendedor explícito usa o default da carteira do cliente', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([{}])                       // Q-A12: lock da institution
      .mockResolvedValueOnce([[{ salesmanId: 22 }]])
      .mockResolvedValueOnce([[{ nextId: 10 }]])
      .mockResolvedValueOnce([[{ nextNumber: 1 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])

    await createOrder({ customerId: 5 }, scope)
    const saleInsert = conn.query.mock.calls[5]
    expect(saleInsert[1]).toContain(22)
  })

  it('cliente sem vendedor explícito NEM default -> 400 SALESMAN_REQUIRED', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[{ salesmanId: null }]]) // lock + cliente

    await expect(createOrder({ customerId: 5 }, scope))
      .rejects.toMatchObject({ statusCode: 400, code: 'SALESMAN_REQUIRED' })
    expect(conn.rollback).toHaveBeenCalled()
  })

  it('cliente inexistente -> 400 ROLE_MISSING', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([{}]).mockResolvedValueOnce([[]]) // lock + cliente inexistente

    await expect(createOrder({ customerId: 999 }, scope))
      .rejects.toMatchObject({ statusCode: 400, code: 'ROLE_MISSING' })
  })
})

describe('createItem (addItem)', () => {
  it('mercadoria (kind P/M) -> item kind Sale, NÃO cria ramo service', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])   // lockOpenOrder
      .mockResolvedValueOnce([[{ kind: 'M' }]])     // produto = mercadoria
      .mockResolvedValueOnce([[{ nextId: 1 }]])     // MAX+1 item
      .mockResolvedValueOnce([{}])                  // insert item
      // recalcTotalizer:
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 2, productValue: 100, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])

    const itemId = await createItem(10, { productId: 3, quantity: 2, unitValue: 50 }, scope)
    expect(itemId).toBe(1)
    const itemInsert = conn.query.mock.calls[3]
    expect(itemInsert[1]).toContain('Sale')
    expect(conn.query.mock.calls.length).toBe(6) // nunca consultou tb_order_sale pro ramo service

    // QA adversarial 2026-08-22: a checagem do produto exige active='S'
    const productQuery = conn.query.mock.calls[1]
    expect(productQuery[0] as string).toContain(`active = 'S'`)
  })

  it('QA adversarial 2026-08-22: produto INATIVO -> 400 (não inclui por ID direto)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]]) // lockOpenOrder
      .mockResolvedValueOnce([[]])                // produto inativo/inexistente -> filtro active='S' exclui

    await expect(createItem(10, { productId: 16, quantity: 1, unitValue: 10 }, scope))
      .rejects.toMatchObject({ statusCode: 400, code: 'ROLE_MISSING' })
  })

  it('serviço (kind S): cria o ramo tb_order_service (1ª vez — conjugada)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])       // lockOpenOrder
      .mockResolvedValueOnce([[{ kind: 'S' }]])         // produto = serviço
      .mockResolvedValueOnce([[{ customerId: 5 }]])     // tb_order_sale (customer)
      .mockResolvedValueOnce([[]])                      // ensureServiceBranch: ainda não existe
      .mockResolvedValueOnce([{}])                      // insert tb_order_service (natureza: só o tomador — 047)
      .mockResolvedValueOnce([[{ nextId: 1 }]])         // MAX+1 item
      .mockResolvedValueOnce([{}])                      // insert item
      .mockResolvedValueOnce([[{ itemsQtde: 1, productQtde: 1, productValue: 80, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])

    const itemId = await createItem(10, { productId: 9, quantity: 1, unitValue: 80 }, scope)
    expect(itemId).toBe(1)
    const serviceInsert = conn.query.mock.calls[4]
    expect((serviceInsert[0] as string)).toContain('tb_order_service')
    // 047: natureza por PRESENÇA — só o tomador; nº e trava são do CICLO (tb_service_order)
    expect((serviceInsert[0] as string)).not.toMatch(/open_lock|number/)
    const itemInsert = conn.query.mock.calls[6]
    expect(itemInsert[1]).toContain('Service')
  })

  it('serviço com ramo já existente NÃO recria tb_order_service', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[{ kind: 'S' }]])
      .mockResolvedValueOnce([[{ customerId: 5 }]])
      .mockResolvedValueOnce([[{ 1: 1 }]])          // ensureServiceBranch: já existe
      .mockResolvedValueOnce([[{ nextId: 2 }]])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([[{ itemsQtde: 2, productQtde: 2, productValue: 160, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])

    const itemId = await createItem(10, { productId: 9, quantity: 1, unitValue: 80 }, scope)
    expect(itemId).toBe(2)
    // nenhuma chamada faz INSERT INTO tb_order_service
    const inserted = conn.query.mock.calls.some(c => (c[0] as string).includes('INSERT INTO') && (c[0] as string).includes('tb_order_service'))
    expect(inserted).toBe(false)
  })

  it('pedido já faturado -> 409 ORDER_INVOICED', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query.mockResolvedValueOnce([[{ status: 'F' }]])

    await expect(createItem(10, { productId: 3, quantity: 1, unitValue: 10 }, scope))
      .rejects.toMatchObject({ statusCode: 409, code: 'ORDER_INVOICED' })
  })

  it('produto inexistente -> 400', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([[]])

    await expect(createItem(10, { productId: 999, quantity: 1, unitValue: 10 }, scope))
      .rejects.toMatchObject({ statusCode: 400, code: 'ROLE_MISSING' })
  })
})

describe('editItem / deleteItem', () => {
  it('editItem: item inexistente -> 404', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([{ affectedRows: 0 }])

    await expect(editItem(10, 999, { productId: 3, quantity: 1, unitValue: 10 }, scope))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('deleteItem: soft delete + recalcula totalizer', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([[{ itemsQtde: 0, productQtde: 0, productValue: 0, discountValue: 0 }]])
      .mockResolvedValueOnce([{}])

    await deleteItem(10, 1, scope)
    expect(conn.commit).toHaveBeenCalled()
  })
})

describe('removeOrder (cancelOrder)', () => {
  it('cancela pedido aberto (soft delete order+sale+service)', async () => {
    const conn = fakeConn()
    ;((pool as any).getConnection as jest.Mock).mockResolvedValue(conn)
    conn.query
      .mockResolvedValueOnce([[{ status: 'A' }]])
      .mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}]).mockResolvedValueOnce([{}])

    await removeOrder(10, scope)
    expect(conn.commit).toHaveBeenCalled()
  })
})

describe('fetchOrder', () => {
  it('pedido inexistente -> 404', async () => {
    mockQuery.mockResolvedValueOnce([[]])
    await expect(fetchOrder(999, scope)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('devolve cabeçalho + itens', async () => {
    mockQuery
      .mockResolvedValueOnce([[{
        id: 10, number: 1, customerId: 5, customerName: 'Cliente',
        salesmanId: 9, salesmanName: 'Vendedor', status: 'A', dtRecord: '2026-08-22',
        totalValue: 100,
      }]])
      .mockResolvedValueOnce([[{
        id: 1, kind: 'Sale', productId: 3, productDescription: 'Peça',
        productKind: 'M', quantity: 2, unitValue: 50, discountValue: 0, total: 100,
      }]])

    const result = await fetchOrder(10, scope)
    expect(result.items).toHaveLength(1)
    expect(result.totalValue).toBe(100)
  })
})
