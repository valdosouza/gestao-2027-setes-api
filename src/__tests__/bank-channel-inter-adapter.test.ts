/// <reference types="jest" />
// Onda 2 — adaptador do Inter (só ele conhece o dialeto). O que se fixa aqui é o
// CONTRATO com a spec oficial (Infra-IA/setes-api/integracoes/banco-inter/):
// token form-urlencoded + cache, header x-conta-corrente derivado da conta,
// payload do emitir (seuNumero ≤ 15, numDiasAgenda 60, pagador), leitura da
// consulta (situacao/boleto/pix), cancelar 202, PDF base64, tradução de erros.
import { interAdapter, resetInterTokenCache, INTER_NUM_DIAS_AGENDA } from '../shared/bank-channel/adapters/inter'
import { transport } from '../shared/bank-channel/https-json'

// transporte injetável: nenhum socket é aberto nos testes
const mockHttp = jest.fn()
transport.request = mockHttp as any

const ctx = {
  channel: {
    bankAccountId: 3, institutionId: 1, environment: 'S' as const, clientId: 'cid', inboundToken: 't'.repeat(48),
    active: 'S' as const, bankNumber: '077', accountNumber: '12345', accountNumberDv: '6',
  },
  secrets: { cert: Buffer.from('cert'), key: Buffer.from('key'), clientSecret: 'sec' },
}
const ok = (obj: unknown, status = 200) => ({ status, headers: {}, text: obj == null ? '' : JSON.stringify(obj) })
const tokenResp = ok({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600, scope: 'x' })

beforeEach(() => { jest.clearAllMocks(); resetInterTokenCache() })

describe('token OAuth', () => {
  it('POST form-urlencoded no /oauth/v2/token do SANDBOX com client_credentials + escopos, sob mTLS; token vai em Bearer e é CACHEADO', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ codigoSolicitacao: 'abc-1' }))
      .mockResolvedValueOnce(ok({ codigoSolicitacao: 'abc-2' }))
    await interAdapter.register(ctx, payer())
    await interAdapter.register(ctx, payer())
    expect(mockHttp).toHaveBeenCalledTimes(3)                 // 1 token para 2 chamadas
    const tok = mockHttp.mock.calls[0][0]
    expect(tok.url).toBe('https://cdpj-sandbox.partners.uatinter.co/oauth/v2/token')
    expect(tok.headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(tok.body).toContain('grant_type=client_credentials')
    expect(tok.body).toContain('client_id=cid')
    expect(tok.body).toContain('client_secret=sec')
    expect(tok.body).toContain('scope=boleto-cobranca.read+boleto-cobranca.write')
    expect(tok.cert).toEqual(Buffer.from('cert')); expect(tok.key).toEqual(Buffer.from('key'))
    const call = mockHttp.mock.calls[1][0]
    expect(call.headers.Authorization).toBe('Bearer tok')
    expect(call.headers['x-conta-corrente']).toBe('123456')  // D-I14: derivado de number + dv, só dígitos
  })

  it('produção usa o host cdpj.partners.bancointer.com.br', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ codigoSolicitacao: 'p' }))
    await interAdapter.register({ ...ctx, channel: { ...ctx.channel, environment: 'P' } }, payer())
    expect(mockHttp.mock.calls[0][0].url).toBe('https://cdpj.partners.bancointer.com.br/oauth/v2/token')
    expect(mockHttp.mock.calls[1][0].url).toBe('https://cdpj.partners.bancointer.com.br/cobranca/v3/cobrancas')
  })

  it('401 numa chamada invalida o token e refaz UMA vez', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 401, headers: {}, text: '{"title":"expired"}' })
      .mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ codigoSolicitacao: 'z' }))
    const r = await interAdapter.register(ctx, payer())
    expect(r.requestCode).toBe('z')
    expect(mockHttp).toHaveBeenCalledTimes(4)
  })

  it('sem client_id → 409 BANK_CHANNEL_SECRET_MISSING antes de qualquer chamada', async () => {
    await expect(interAdapter.query({ ...ctx, channel: { ...ctx.channel, clientId: null } }, 'x'))
      .rejects.toMatchObject({ statusCode: 409, code: 'BANK_CHANNEL_SECRET_MISSING' })
    expect(mockHttp).not.toHaveBeenCalled()
  })
})

function payer() {
  return {
    reference: '262', amount: 250, dueDate: '2026-10-10',
    payer: { document: '12345678000199', personType: 'J' as const, name: 'Cliente Ltda', street: 'Rua A, 10', neighborhood: 'Centro', city: 'Curitiba', state: 'PR', zipCode: '80000000' },
    messages: ['linha um', 'linha dois'], finePercent: 2, interestMonthly: 1, discountPercent: null, discountDays: null,
  }
}

describe('emitir (POST /cobrancas)', () => {
  it('payload da spec: seuNumero, valorNominal, dataVencimento, numDiasAgenda=60 (D-I19), pagador completo, mensagem, multa/mora', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ codigoSolicitacao: 'uuid-1' }))
    const r = await interAdapter.register(ctx, payer())
    expect(r).toEqual({ requestCode: 'uuid-1' })
    const body = JSON.parse(mockHttp.mock.calls[1][0].body)
    expect(body).toMatchObject({
      seuNumero: '262', valorNominal: 250, dataVencimento: '2026-10-10', numDiasAgenda: INTER_NUM_DIAS_AGENDA,
      pagador: { cpfCnpj: '12345678000199', tipoPessoa: 'JURIDICA', nome: 'Cliente Ltda', endereco: 'Rua A, 10', bairro: 'Centro', cidade: 'Curitiba', uf: 'PR', cep: '80000000' },
      mensagem: { linha1: 'linha um', linha2: 'linha dois' },
      multa: { codigo: 'PERCENTUAL', taxa: 2 }, mora: { codigo: 'TAXAMENSAL', taxa: 1 },
    })
    expect(body.desconto).toBeUndefined()
    expect(INTER_NUM_DIAS_AGENDA).toBe(60)
  })

  it('banco recusa (400 com violacoes) → 422 BANK_REJECTED com a mensagem do banco', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({
      status: 400, headers: {}, text: JSON.stringify({ title: 'Erro', detail: 'payload inválido', violacoes: [{ propriedade: 'pagador.cep', razao: 'inválido' }] }),
    })
    await expect(interAdapter.register(ctx, payer())).rejects.toMatchObject({
      statusCode: 422, code: 'BANK_REJECTED', message: expect.stringMatching(/pagador\.cep: inválido/),
    })
  })

  it('rede/timeout → 503 BANK_UNAVAILABLE; 5xx idem; 429 → BANK_RATE_LIMITED; 403 → BANK_AUTH_FAILED', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockRejectedValueOnce(new Error('timeout'))
    await expect(interAdapter.query(ctx, 'c')).rejects.toMatchObject({ statusCode: 503, code: 'BANK_UNAVAILABLE' })
    mockHttp.mockResolvedValueOnce({ status: 503, headers: {}, text: '' })
    await expect(interAdapter.query(ctx, 'c')).rejects.toMatchObject({ statusCode: 503, code: 'BANK_UNAVAILABLE' })
    mockHttp.mockResolvedValueOnce({ status: 429, headers: {}, text: '' })
    await expect(interAdapter.query(ctx, 'c')).rejects.toMatchObject({ code: 'BANK_RATE_LIMITED' })
    mockHttp.mockResolvedValueOnce({ status: 403, headers: {}, text: '{"detail":"escopo"}' })
    await expect(interAdapter.query(ctx, 'c')).rejects.toMatchObject({ statusCode: 409, code: 'BANK_AUTH_FAILED' })
  })
})

describe('consultar / cancelar / pdf / pagar', () => {
  it('consulta traduz cobranca + boleto + pix para a situação neutra', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({
      cobranca: { codigoSolicitacao: 'uuid-1', seuNumero: '262', situacao: 'RECEBIDO', dataSituacao: '2026-09-21', valorNominal: 250, valorTotalRecebido: '250.00', origemRecebimento: 'PIX' },
      boleto: { nossoNumero: '00012345678', linhaDigitavel: '7'.repeat(47), codigoBarras: '7'.repeat(44) },
      pix: { txid: 'TX'.repeat(14), pixCopiaECola: '000201...' },
    }))
    const st = await interAdapter.query(ctx, 'uuid-1')
    expect(st).toMatchObject({
      requestCode: 'uuid-1', reference: '262', status: 'RECEBIDO', statusAt: '2026-09-21', amount: 250, paidValue: 250, paidBy: 'PIX',
      bankOurNumber: '00012345678', digitableLine: '7'.repeat(47), barcode: '7'.repeat(44), pixCopyPaste: '000201...',
    })
    expect(mockHttp.mock.calls[1][0].url).toBe('https://cdpj-sandbox.partners.uatinter.co/cobranca/v3/cobrancas/uuid-1')
  })

  it('EM_PROCESSAMENTO sem boleto/pix → campos null (chegam depois — write-once na apresentação)', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ cobranca: { codigoSolicitacao: 'u', situacao: 'EM_PROCESSAMENTO' } }))
    const st = await interAdapter.query(ctx, 'u')
    expect(st.digitableLine).toBeNull(); expect(st.pixCopyPaste).toBeNull(); expect(st.status).toBe('EM_PROCESSAMENTO')
  })

  it('cancelar: POST /cancelar {motivoCancelamento ≤ 50} e aceita 202 sem corpo', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 202, headers: {}, text: '' })
    await interAdapter.cancel(ctx, 'u', 'x'.repeat(80))
    const call = mockHttp.mock.calls[1][0]
    expect(call.url).toMatch(/\/cobrancas\/u\/cancelar$/)
    expect(JSON.parse(call.body).motivoCancelamento).toHaveLength(50)
  })

  it('pdf: {pdf: base64} → Buffer', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({ pdf: Buffer.from('%PDF-1.4').toString('base64') }))
    const buf = await interAdapter.pdf(ctx, 'u')
    expect(buf.toString()).toBe('%PDF-1.4')
  })

  it('pagar (sandbox) recusa em produção sem chamar o banco', async () => {
    await expect(interAdapter.paySandbox({ ...ctx, channel: { ...ctx.channel, environment: 'P' } }, 'u', 'PIX'))
      .rejects.toMatchObject({ code: 'BANK_REJECTED' })
    expect(mockHttp).not.toHaveBeenCalled()
  })

  it('webhookGet: 404 do banco = "sem webhook" (null), não erro', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce({ status: 404, headers: {}, text: '' })
    expect(await interAdapter.webhookGet(ctx)).toBeNull()
  })

  it('findByReference filtra por seuNumero e devolve só as que casam', async () => {
    mockHttp.mockResolvedValueOnce(tokenResp).mockResolvedValueOnce(ok({
      cobrancas: [{ cobranca: { codigoSolicitacao: 'a', seuNumero: '262', situacao: 'A_RECEBER' } }, { cobranca: { codigoSolicitacao: 'b', seuNumero: '263', situacao: 'A_RECEBER' } }],
    }))
    const list = await interAdapter.findByReference(ctx, '262', '2026-09-01', '2026-09-20')
    expect(list.map(x => x.requestCode)).toEqual(['a'])
    expect(mockHttp.mock.calls[1][0].url).toContain('seuNumero=262')
  })
})
