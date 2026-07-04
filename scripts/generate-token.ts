import jwt from 'jsonwebtoken'

const secret = 'sucessoem2027!'

// Fase 2: institutionId (int) no lugar de tenantId (string) — decisão 16/18.
// TTL 24h, sem refresh token — decisão 19.
const tokenAlpha = jwt.sign(
  { institutionId: 2, userId: 2, role: 'user', schemaName: 'setes_alpha' },
  secret,
  { expiresIn: '24h' }
)

const tokenBeta = jwt.sign(
  { institutionId: 3, userId: 3, role: 'user', schemaName: 'setes_beta' },
  secret,
  { expiresIn: '24h' }
)

// 'super' só é reconhecido na institution 1 (Setes) — decisão 14
const tokenSetes = jwt.sign(
  { institutionId: 1, userId: 1, role: 'super', schemaName: 'setes_setes' },
  secret,
  { expiresIn: '24h' }
)

console.log('Token Alpha (ERP habilitado):\n', tokenAlpha)
console.log('\nToken Beta (ERP bloqueado):\n', tokenBeta)
console.log('\nToken Setes Super:\n', tokenSetes)
