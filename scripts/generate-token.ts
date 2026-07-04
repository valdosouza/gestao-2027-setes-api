import jwt from 'jsonwebtoken'

const secret = 'sucessoem2027!'

const tokenAlpha = jwt.sign(
  { tenantId: 'tenant-001', userId: 'user-001', role: 'client_user', schemaName: 'setes_alpha' },
  secret,
  { expiresIn: '24h' }
)

const tokenBeta = jwt.sign(
  { tenantId: 'tenant-002', userId: 'user-002', role: 'client_user', schemaName: 'setes_beta' },
  secret,
  { expiresIn: '24h' }
)

const tokenSetes = jwt.sign(
  { tenantId: 'setes', userId: 'admin-001', role: 'setes_admin', schemaName: 'setes_central' },
  secret,
  { expiresIn: '24h' }
)

console.log('Token Alpha (ERP habilitado):\n', tokenAlpha)
console.log('\nToken Beta (ERP bloqueado):\n', tokenBeta)
console.log('\nToken Setes Admin:\n', tokenSetes)
