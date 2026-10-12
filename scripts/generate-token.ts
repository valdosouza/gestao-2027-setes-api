// Gera tokens FINAIS de dev para chamar a API à mão (curl, Swagger). D-F13 (F2a, etapa A2): RS256 com `kid`, assinado
// pela chave privada do .env (JWT_PRIVATE_KEY_PATH / JWT_KID) — o mesmo caminho do login. Nunca um segredo fixo aqui
// (o HS256 antigo tinha o segredo de produção versionado neste arquivo; aposentado com o RS256).
// Uso: npx tsx --require tsconfig-paths/register scripts/generate-token.ts [institutionId] [userId] [role] [schemaName] [ttl]
import 'dotenv/config'
import { signFinalToken } from '../src/shared/auth/product-token'

const [institutionId = '1', userId = '1', role = 'super', schemaName = 'setes_setes', ttl = '2h'] = process.argv.slice(2)
process.stdout.write(signFinalToken({ institutionId: Number(institutionId), userId: Number(userId), role, schemaName }, ttl) + '\n')
