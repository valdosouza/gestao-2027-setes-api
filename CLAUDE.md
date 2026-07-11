# CLAUDE.md

## ⚠️ Base de conhecimento central: D:\Gestao2027\Infra-IA

Antes de qualquer tarefa neste projeto, consulte `D:\Gestao2027\Infra-IA\INDICE_CENTRAL.md`
(documentação, skills, agentes e decisões arquiteturais vigentes). Em especial:
- Banco de dados: `Infra-IA/database/PADROES_BANCO.md` + skill `revisar-ddl.md` (obrigatório antes de DDL)
- Decisões vigentes (Fase 2): `Infra-IA/setes-api/prompt_fase2_gerenciamento_central.md` — JWT usa
  `institutionId` int (nunca `tenantId`), tabelas `tb_institution`/`tb_feature_flag`/`tb_sync_api_key`,
  schemas `setes_<nome>`.
Ao concluir tarefa que gere conhecimento novo, siga `Infra-IA/skills-genericas/atualizar-infra-ia.md`.



This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Commands

```bash
# Development
npm run dev                 # Start with hot reload (tsx watch)
npm run build              # Build TypeScript to dist/
npm start                  # Run compiled JavaScript

# Testing
npm test                   # Run all tests
npm test -- specific.test  # Run specific test file
npm test -- --testNamePattern="pattern" # Run tests matching pattern

# Check
npx tsc --noEmit          # Type check without emitting
```

## Architecture Overview

**setes-api** is a modular multi-tenant Express.js API serving:
- **setes-app** (Flutter web client) via JWT authentication
- **Sincronizador** (Delphi legacy system) via X-Api-Key header for data sync endpoints

### Request Flow

```
Health Check (no auth)
    ↓
├─→ /health → 200 OK (always open)
│
└─→ /sync/* (Sincronizador endpoints)
    ├─ X-Api-Key authentication
    ├─ No feature-flag check
    ├─ Rate limited
    └─ Receives JSON from Firebird through Delphi
        └─ Used by sync modules (brand, customer, financial, etc.)

└─→ /api/* (Client app endpoints)
    ├─ JWT authentication
    ├─ Feature-flag middleware (per module)
    ├─ Rate limited
    └─ Routes by module (core, erp, admin, etc.)
```

## Code Structure

### Folder Organization

```
src/
├── gateway/           # Middlewares & entry point
│   ├── auth.middleware.ts          # JWT validation
│   ├── feature-flag.middleware.ts  # Module access control
│   ├── rate-limit.middleware.ts    # Per-tenant rate limiting
│   ├── super.guard.ts              # isSuper() — aplicado POR MÓDULO nos cadastros do catálogo central
│   └── router.ts                   # Routes registration (1 cadastro = /api/<modulo> + guard)
├── modules/           # Feature modules — 1 CADASTRO = 1 MÓDULO (simetria com o setes-app)
│   ├── countries/     # countries.{interface,dto,repository,service,controller,routes}.ts
│   ├── states/        # idem (JOIN devolve countryName)
│   ├── cities/        # idem (JOIN devolve stateName)
│   ├── interfaces/    # idem + tb_interface_has_privilege (N:N pertence a este módulo)
│   ├── privileges/    # idem
│   ├── admin/         # Admin operations (repository, service, routes)
│   ├── core/          # Tenant info & setup (GET /api/core/menus lê tb_interface)
│   ├── erp/           # ERP module stub
│   └── sync/          # Sync endpoints from Sincronizador
│       ├── endpoints/         # One file per data type (brand.ts, customer.ts, etc.)
│       └── sync.specific.routes.ts  # Routes for /sync prefix
├── feature-flags/     # Feature flag system
│   ├── flag.service.ts      # In-memory cache with TTL
│   └── flag.repository.ts   # DB queries
├── migrations/        # Database schema management
├── shared/
│   ├── db/connection.ts     # MySQL pool (decimalNumbers: true — NUNCA remover)
│   ├── errors/http-error.ts # Custom HTTP error class
│   ├── http/controller-utils.ts # handleError + parseId (todo controller usa)
│   ├── logger/logger.ts     # Simple console logger with timestamps
│   └── types/express.d.ts   # TypeScript augmentation for req.tenant
├── app.ts            # Express app configuration
└── server.ts         # Server bootstrap
```

### Module Pattern (Routes → Controller → Service → Repository)

**Cadastros seguem o padrão simétrico com o setes-app** — regras completas e
checklist em `D:\Gestao2027\Infra-IA\setes-api\ARQUITETURA_MODULOS_API.md`
(LER antes de criar/alterar módulo de cadastro). Resumo:

- `<m>.interface.ts` tipos Row/Input · `<m>.dto.ts` Zod · `<m>.repository.ts` SQL
  · `<m>.service.ts` regra (404/409/MAX+1) · `<m>.controller.ts` HTTP ↔ service
  · `<m>.routes.ts` router fino + Swagger
- "Super" NÃO é módulo — nem pasta, nem URL: é só agrupador de menu no app. A URL
  segue o módulo: `/api/<modulo>` espelha `/home/<modulo>` (ex.: /api/countries).
  Guard POR MÓDULO no gateway: `router.use('/countries', superGuard, countriesRoutes)`
- Módulo nunca importa módulo; compartilhado vai para `shared/`
- Módulos legados (admin, core, erp, sync) ainda usam Repository → Service → Routes
  sem controller/dto separados — migrar quando forem tocados

## Authentication & Authorization

### JWT (Client Apps)

All `/api/*` routes require JWT in header:
```
Authorization: Bearer <jwt_token>
```

**Payload shape** (in `src/shared/types/express.d.ts`):
```typescript
{
  tenantId: string      // Unique per client
  userId: string        // User identifier
  role: 'setes_admin' | 'client_user'
  schemaName: string    // Database schema for this tenant
}
```

**Special case**: `tenantId = 'setes'` and `role = 'setes_admin'` bypasses feature flags.

### X-Api-Key (Sincronizador)

`/sync/*` routes use header-based API key (set in .env as `SYNC_API_KEY`):
```
X-Api-Key: <shared_key>
```

These routes skip JWT, feature-flag, and are used only by the Delphi synchronizer.

## Feature Flags

Located in MySQL `feature_flags` table. Each tenant has per-module toggles.

**How it works**:
1. Feature flag middleware extracts module key from URL (e.g., `/api/erp/status` → `erp`)
2. Calls `isModuleEnabled(tenantId, moduleKey)`
3. If not enabled and user is not setes_admin, returns 403

**Cache**: In-memory with TTL (default 60s, configurable via `FLAG_CACHE_TTL_MS`)

## Multi-Tenant & Database Schemas

Each client has its own MySQL schema (e.g., `schema_tenant_001`, `schema_beta`).

**Connection flow**:
```typescript
const conn = await getConnection(schemaName) // Uses `USE schema_name`
const [rows] = await conn.query('SELECT * FROM table')
conn.release()
```

Central database (`setes_central`) holds:
- `tenants` table (schema names, client metadata)
- `feature_flags` table (per-tenant module toggles)

## Sync Module & Sincronizador Integration

**Sync endpoints** (`/sync/*`) receive JSON payloads from Delphi containing data from Firebird.

**Endpoint pattern** (`src/modules/sync/endpoints/*.ts`):
```typescript
// brand.ts example
router.post('/brand/sincronize', async (req, res) => {
  const { brands } = req.body
  // Store brands in tenant's schema
  await storeBrands(req.tenant!.schemaName, brands)
  res.json({ ok: true })
})
```

**Important**: `/sync` routes are prefixed directly on `app` (not under `/api`), skip JWT, and use X-Api-Key instead.

## Rate Limiting

Uses `express-rate-limit` with **per-tenant keying**:
- **Window**: 60 seconds
- **Max requests**: 300 per tenant
- **Anonymous/unauthenticated**: Falls back to IP address

## Environment Variables

```bash
PORT=3000
JWT_SECRET=your_secret_key_here
SYNC_API_KEY=delphi_shared_api_key
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=password
DB_NAME=setes_central
FLAG_CACHE_TTL_MS=60000
```

## Testing Notes

- Jest preset configured in `package.json` with path alias mapping
- Tests use `supertest` for HTTP assertions
- `ts-jest` handles TypeScript compilation

Example test:
```typescript
import request from 'supertest'
import app from '../app'

describe('GET /health', () => {
  it('returns status ok', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })
})
```

## Common Workflows

**Adding a new API endpoint**:
1. Create file in `src/modules/[module]/[module].routes.ts` (or edit existing)
2. Implement repository query in `[module].repository.ts`
3. Add service logic in `[module].service.ts`
4. Register route in `src/gateway/router.ts` if new module
5. If new module needs feature flag: add entry to `feature_flags` table

**Adding a new sync endpoint**:
1. Create `src/modules/sync/endpoints/[datatype].ts`
2. Define POST route at `/[datatype]/sincronize`
3. Extract tenant info from request context
4. Store data in tenant's schema

**Debugging requests**:
- Check `src/shared/logger/logger.ts` — log middleware calls and errors
- Verify `req.tenant` is set after auth middleware
- Check feature flags cache with `FLAG_CACHE_TTL_MS`

## Key Files to Know

| File | Purpose |
|------|---------|
| `src/app.ts` | Express setup, middleware order, sync vs. JWT routing |
| `src/gateway/router.ts` | All `/api/*` route registrations |
| `src/modules/sync/sync.specific.routes.ts` | All `/sync/*` route registrations |
| `src/shared/db/connection.ts` | MySQL pool and schema switching |
| `src/shared/types/express.d.ts` | `req.tenant` type definitions |
| `.env.example` | Template for all environment variables |
