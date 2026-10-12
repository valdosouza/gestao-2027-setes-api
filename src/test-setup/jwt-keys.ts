/**
 * Setup GLOBAL do jest (D-F13 — F2a, etapa A2): o setes-api assina e verifica o JWT do produto em RS256 com `kid`
 * (`@shared/auth/product-token`) e NÃO lê mais `JWT_SECRET`. Aqui nasce o par de chaves de TESTE — gerado uma vez
 * por máquina numa pasta temporária (gerar RSA a cada arquivo de teste custaria segundos) — e o ambiente aponta
 * para ele. Nada disto é chave de produção. Os testes assinam pelo `testToken` (`./test-token`).
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { generateKeyPairSync } from 'crypto'

export const TEST_JWT_DIR = path.join(os.tmpdir(), 'setes-api-jest-jwt-v1')
export const TEST_JWT_KID = 'test'

function ensureKey(name: string): string {
  const file = path.join(TEST_JWT_DIR, `${name}.private.pem`)
  if (!fs.existsSync(file)) {
    fs.mkdirSync(TEST_JWT_DIR, { recursive: true })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    fs.renameSync(tmp, file)                       // atômico: outro worker nunca lê meia chave
  }
  return file
}

process.env.JWT_PRIVATE_KEY_PATH = ensureKey('signer')
process.env.JWT_KID = TEST_JWT_KID
process.env.TEST_JWT_OTHER_KEY_PATH = ensureKey('other')   // chave de um "outro" emissor: assinatura válida, kid desconhecido
delete process.env.JWT_PUBLIC_KEYS
