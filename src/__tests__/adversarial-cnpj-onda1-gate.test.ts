/// <reference types="jest" />
// GATE ADVERSARIAL da ONDA 1 da frente do CNPJ alfanumérico (skill `testar-adversarial.md`, 2026-10-16) — setes-api.
// Alvo: a PORTA de ESCRITA (`fiscal.dto.ts` — D-CJ3/D-CJ8) nos 5 papéis + o envelope (`zodToFields`, `fields[].expected` número × texto).
// Ataque que RESISTIU = teste verde que fixa a garantia. Achado CONFIRMADO = teste que FALHAVA, marcado `[ACHADO <SEVERIDADE>]` — corrigido na sessão de entrega (§8.10 do prompt).
// Sem banco (nada é lido nem escrito): só DTO, conversor do envelope e `parseBody` com resposta falsa.
import { z } from 'zod'
import { Request, Response } from 'express'
import { companyBody, personBody } from '../shared/fiscal/fiscal.dto'
import { zodToFields, parseBody } from '../shared/http/controller-utils'
import { customerCreateDto, customerUpdateDto } from '../modules/customers/customers.dto'
import { carrierCreateDto, carrierUpdateDto } from '../modules/carriers/carriers.dto'
import { providerCreateDto, providerUpdateDto } from '../modules/providers/providers.dto'
import { collaboratorCreateDto, collaboratorUpdateDto } from '../modules/collaborators/collaborators.dto'
import { institutionCreateDto, institutionUpdateDto } from '../modules/institutions/institutions.dto'
import { isValidCnpj, isValidCpf, normalizeCnpj, normalizeCpf } from '../shared/validation'
import { cnpjCheckDigits } from 'fiscal-api/federal-id'

const ALFA = 'PC3D315K000193'
const fieldsOf = (schema: z.ZodTypeAny, body: unknown) => {
  const r = schema.safeParse(body)
  return r.success ? [] : zodToFields(r.error)
}

// PRNG determinístico (mulberry32) — a falha reproduz
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const randomValidCnpj = (r: () => number) => {
  const base = Array.from({ length: 12 }, () => ALNUM[Math.floor(r() * ALNUM.length)]).join('')
  return base + cnpjCheckDigits(base)!
}
/** Pedaços que um atacante cola: máscara, minúscula, brancos de toda sorte, sósias Unicode, dígitos de outras escritas. */
const NOISE = ['.', '/', '-', ' ', '\t', '\n', ' ', '\u0085', '﻿', '​', ' ', '_', ',', 'Á', 'ı', 'ſ', 'K' /* K Kelvin */,
  '０', '٣', '¹', '̇', 'a', 'z', 'k', 'é', 'ß', '\u0000', '%', "'", '"']

describe('promessa 1 — a porta de ESCRITA dos 5 papéis (create E update) abre só para a forma canônica', () => {
  const pj = (cnpj: unknown, extra: Record<string, unknown> = {}) => ({
    personType: 'J', company: { cnpj }, entity: { nameCompany: 'Empresa Nova LTDA', nickTrade: 'Nova' }, ...extra,
  })
  const instCreateExtra = { schemaName: 'setes_nova', admin: { nameCompany: 'Adm', nickTrade: 'Adm', email: 'a@b.com', password: '12345' } }
  const DTOS: Array<[string, z.ZodTypeAny, Record<string, unknown>]> = [
    ['customerCreate', customerCreateDto, {}], ['customerUpdate', customerUpdateDto, {}],
    ['carrierCreate', carrierCreateDto, {}], ['carrierUpdate', carrierUpdateDto, {}],
    ['providerCreate', providerCreateDto, {}], ['providerUpdate', providerUpdateDto, {}],
    ['collaboratorCreate', collaboratorCreateDto, {}], ['collaboratorUpdate', collaboratorUpdateDto, {}],
    ['institutionCreate', institutionCreateDto, instCreateExtra], ['institutionUpdate', institutionUpdateDto, {}],
  ]
  it.each(DTOS)('%s: alfanumérico canônico PASSA; minúscula/máscara recusam com expected canônico no caminho company.cnpj', (_n, dto, extra) => {
    expect(dto.safeParse(pj(ALFA, extra)).success).toBe(true)
    expect(dto.safeParse(pj('00000000E08G12', extra)).success).toBe(true)
    for (const [sent, expected] of [['pc3d315k000193', ALFA], ['PC.3D3.15K/0001-93', ALFA], [`${ALFA} `, ALFA]] as const) {
      const f = fieldsOf(dto, pj(sent, extra)).filter(x => x.field === 'company.cnpj')
      expect([sent, f]).toEqual([sent, [expect.objectContaining({ field: 'company.cnpj', expected })]])
    }
  })
  it.each(DTOS)('%s: nunca aceita minúscula, máscara, branco, Unicode estranho nem DV errado', (_n, dto, extra) => {
    for (const bad of ['pc3d315k000193', 'PC.3D3.15K/0001-93', ` ${ALFA}`, `${ALFA}\n`, 'PC3D315K000193', 'PC3D315K00019３',
      'PC3D315K000194', 'PC3D315K0001930', 'PC3D315K00019', '', '0', ALFA.replace('K', 'ı')]) {
      expect([bad, dto.safeParse(pj(bad, extra)).success]).toEqual([bad, false])
    }
  })
  it('CNPJ no lugar do CPF (e CPF no lugar do CNPJ) é recusado — o tipo vem do LUGAR', () => {
    expect(personBody.safeParse({ cpf: ALFA }).success).toBe(false)
    expect(personBody.safeParse({ cpf: '12345678000195' }).success).toBe(false)
    expect(companyBody.safeParse({ cnpj: '52998224725' }).success).toBe(false)
  })
})

describe('promessa 1 — fuzz: aceita ⇔ válido canônico; `expected` só quando a forma canônica sugerida é VÁLIDA (e ≠ do enviado)', () => {
  const r = rng(20261016)
  const samples: string[] = []
  for (let i = 0; i < 6000; i++) {
    const c = randomValidCnpj(r)
    const roll = r()
    let s = c
    if (roll < 0.25) s = `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
    else if (roll < 0.45) s = c.toLowerCase()
    // injeta 1–3 ruídos em posições aleatórias
    if (r() < 0.6) {
      const n = 1 + Math.floor(r() * 3)
      for (let k = 0; k < n; k++) {
        const p = Math.floor(r() * (s.length + 1))
        s = s.slice(0, p) + NOISE[Math.floor(r() * NOISE.length)] + s.slice(p)
      }
    }
    if (r() < 0.1) s = s.slice(0, Math.floor(r() * s.length))                    // truncado
    if (r() < 0.1) s = s.replace(/\d(?=\d?$)/, d => String((Number(d) + 1) % 10)) // DV adulterado
    samples.push(s)
  }
  it('6.000 entradas adversariais: nenhuma divergência do invariante', () => {
    const bad: string[] = []
    for (const v of samples) {
      const parsed = companyBody.safeParse({ cnpj: v })
      if (parsed.success !== isValidCnpj(v)) { bad.push(`aceite≠válido: ${JSON.stringify(v)}`); continue }
      if (parsed.success) {
        if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) bad.push(`aceitou fora da forma: ${JSON.stringify(v)}`)
        continue
      }
      const f = zodToFields(parsed.error)
      if (f.length !== 1 || f[0].field !== 'cnpj') { bad.push(`envelope: ${JSON.stringify(v)} → ${JSON.stringify(f)}`); continue }
      const canonical = normalizeCnpj(v)
      const shouldSuggest = canonical !== null && canonical !== v && isValidCnpj(canonical)
      if ('expected' in f[0]) {
        if (!shouldSuggest) bad.push(`sugeriu sem dever: ${JSON.stringify(v)} → ${f[0].expected}`)
        if (typeof f[0].expected !== 'string' || !isValidCnpj(f[0].expected)) bad.push(`sugeriu INVÁLIDO: ${JSON.stringify(v)} → ${f[0].expected}`)
        if (f[0].expected !== canonical) bad.push(`sugeriu outro: ${JSON.stringify(v)} → ${f[0].expected}`)
      } else if (shouldSuggest) bad.push(`deixou de sugerir: ${JSON.stringify(v)}`)
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
  it('CPF: mesmo invariante (segue numérico)', () => {
    const r2 = rng(529982247)
    const bad: string[] = []
    for (let i = 0; i < 3000; i++) {
      const d = Array.from({ length: 9 }, () => Math.floor(r2() * 10))
      for (const pos of [9, 10]) {
        let sum = 0
        for (let k = 0; k < pos; k++) sum += d[k] * (pos + 1 - k)
        d.push(((sum * 10) % 11) % 10)
      }
      let s = d.join('')
      if (r2() < 0.4) s = `${s.slice(0, 3)}.${s.slice(3, 6)}.${s.slice(6, 9)}-${s.slice(9)}`
      if (r2() < 0.5) { const p = Math.floor(r2() * (s.length + 1)); s = s.slice(0, p) + NOISE[Math.floor(r2() * NOISE.length)] + s.slice(p) }
      const parsed = personBody.safeParse({ cpf: s })
      if (parsed.success !== isValidCpf(s)) { bad.push(`aceite≠válido: ${JSON.stringify(s)}`); continue }
      if (parsed.success) continue
      const f = zodToFields(parsed.error)[0]
      const c = normalizeCpf(s)
      const should = c !== null && c !== s && isValidCpf(c)
      if (('expected' in f) !== should || (should && f.expected !== c)) bad.push(`expected: ${JSON.stringify(s)} → ${JSON.stringify(f)}`)
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
  it('entrada de 1 MB não trava a porta (regex linear) e não sugere nada', () => {
    const huge = 'A'.repeat(1_000_000)
    const t0 = Date.now()
    const f = fieldsOf(companyBody, { cnpj: huge })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(f).toEqual([{ field: 'cnpj', message: expect.stringMatching(/12 letras ou números/) }])
  })
})

describe('promessa 1 — o MOTIVO da recusa', () => {
  it('máscara sobre DV errado, minúscula sobre DV errado: "não confere", SEM expected', () => {
    for (const v of ['pc3d315k000194', '12.345.678/0001-99', ' 12345678000199 ']) {
      const f = fieldsOf(companyBody, { cnpj: v })
      expect([v, f[0].message, 'expected' in f[0]]).toEqual([v, expect.stringMatching(/dígito verificador não confere/), false])
    }
  })
  it('Unicode que o `toUpperCase` viraria ASCII (ı, ſ, Kelvin) e dígitos de outra escrita: "12 letras ou números", SEM expected', () => {
    for (const v of ['pc3d315k00019ı', 'PC3D315K000193', 'ſC3D315K000193', 'PC3D315K00019٣', 'PC3D​315K000193']) {
      const f = fieldsOf(companyBody, { cnpj: v })
      expect([v, f[0].message, 'expected' in f[0]]).toEqual([v, expect.stringMatching(/12 letras ou números/), false])
    }
  })
  // O DV dos 14 zeros (e dos 11 iguais do CPF) CONFERE — o que os recusa é o VETO dos dígitos iguais. A mensagem afirma o falso.
  it('[CORRIGIDO na sessão — ACHADO LOW] "00000000000000" / "11111111111": o DV CONFERE — a recusa diz o motivo certo (dígitos iguais), não "DV não confere"', () => {
    expect(cnpjCheckDigits('000000000000')).toBe('00')                     // prova: o DV dos 14 zeros fecha
    const cnpj = fieldsOf(companyBody, { cnpj: '00000000000000' })[0]
    const cpf = fieldsOf(personBody, { cpf: '11111111111' })[0]
    expect(cnpj.message).not.toMatch(/dígito verificador não confere/)
    expect(cpf.message).not.toMatch(/dígito verificador não confere/)
  })
})

describe('promessa 1 — envelope: `expected` número × texto, e issues que NÃO são custom', () => {
  it('invalid_type (cnpj número): o `expected` do PRÓPRIO Zod ("string") NÃO vaza para o envelope', () => {
    const r = companyBody.safeParse({ cnpj: 12345678000195 })
    expect(r.success).toBe(false)
    const issue = (r as any).error.issues[0]
    expect(issue.expected).toBe('string')                                 // o Zod tem esse campo…
    expect(zodToFields((r as any).error)).toEqual([{ field: 'cnpj', message: issue.message }])   // …e ele não sai
  })
  it('issue NÃO custom com `params.expected` forjado não leva expected; custom com objeto/booleano/array/null também não', () => {
    const err = new z.ZodError([
      { code: 'invalid_string', validation: 'regex', message: 'x', path: ['a'], params: { expected: 'EVIL' } } as any,
      { code: 'too_small', minimum: 1, inclusive: true, type: 'string', message: 'y', path: ['b'], expected: 'EVIL2' } as any,
      { code: 'custom', message: 'o', path: ['c'], params: { expected: { a: 1 } } },
      { code: 'custom', message: 'b', path: ['d'], params: { expected: true } },
      { code: 'custom', message: 'l', path: ['e'], params: { expected: ['PC3D315K000193'] } },
      { code: 'custom', message: 'n', path: ['f'], params: { expected: null } },
      { code: 'custom', message: 'u', path: ['g'] },
    ])
    for (const f of zodToFields(err)) expect([f.field, 'expected' in f]).toEqual([f.field, false])
  })
  it('custom com número (D-N3) segue número; com texto segue texto — sem coerção cruzada', () => {
    const err = new z.ZodError([
      { code: 'custom', message: 'n', path: ['parcels'], params: { expected: 3 } },
      { code: 'custom', message: 'z', path: ['zero'], params: { expected: 0 } },
      { code: 'custom', message: 't', path: ['company', 'cnpj'], params: { expected: '12ABC34501DE35' } },
    ])
    expect(zodToFields(err)).toEqual([
      { field: 'parcels', message: 'n', expected: 3 },
      { field: 'zero', message: 'z', expected: 0 },
      { field: 'company.cnpj', message: 't', expected: '12ABC34501DE35' },
    ])
  })
  it('as outras recusas do mesmo corpo (toggle triplo, entity) NÃO ganham expected; só o CNPJ', () => {
    const f = fieldsOf(customerCreateDto, { personType: 'J', person: { cpf: '529.982.247-25' }, company: { cnpj: 'pc3d315k000193' },
      entity: { nameCompany: '', nickTrade: 'x' } })
    const withExpected = f.filter(x => 'expected' in x)
    expect(withExpected).toEqual([
      expect.objectContaining({ field: 'person.cpf', expected: '52998224725' }),
      expect.objectContaining({ field: 'company.cnpj', expected: ALFA }),
    ])
    expect(f.some(x => x.field === 'person' && !('expected' in x))).toBe(true)   // "personType='J' não aceita person"
  })
  it('parseBody: 400 VALIDATION_FAILED com expected TEXTO que sobrevive ao JSON', () => {
    let status = 0, body: any = null
    const res = { status(s: number) { status = s; return this }, json(b: unknown) { body = JSON.parse(JSON.stringify(b)); return this } } as unknown as Response
    const out = parseBody(customerCreateDto, { body: { personType: 'J', company: { cnpj: '12.abc.345/01de-35' }, entity: { nameCompany: 'A', nickTrade: 'A' } } } as Request, res)
    expect(out).toBeNull()
    expect(status).toBe(400)
    expect(body).toEqual({ error: expect.any(String), code: 'VALIDATION_FAILED',
      fields: [{ field: 'company.cnpj', message: expect.stringMatching(/fora da forma canônica/), expected: '12ABC34501DE35' }] })
  })
  it('reenviar o `expected` devolvido PASSA (o cliente corrige sem fazer parse da prosa) — e nunca muda a inscrição', () => {
    const r = rng(7)
    for (let i = 0; i < 500; i++) {
      const c = randomValidCnpj(r)
      const sent = `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`.toLowerCase()
      const f = fieldsOf(companyBody, { cnpj: sent })[0]
      expect(f.expected).toBe(c)
      expect(companyBody.safeParse({ cnpj: f.expected }).success).toBe(true)
    }
  })
})
