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

⚠️ Sincronização com o legado NÃO vive aqui: é o projeto irmão **setes-sync**
(porta 3001) — regra canônica dos dois grupos (setes-app↔setes-api ×
Sincronizador↔setes-sync). Nada de rotas/módulos `/sync` neste projeto
(módulo legado removido em 2026-08-24 por decisão do Valdo).

### Request Flow

```
Health Check (no auth)
    ↓
├─→ /health → 200 OK (always open)
│
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
│   ├── institutions/  # cadeia de entidade fiscal (skill cadastro-entidade-fiscal.md):
│   │                  # cascade em transação única; POST absorveu o onboarding
│   │                  # (cadeia → runMigrationsForSchema → active='S')
│   ├── admin/         # Admin operations (POST /institutions APOSENTADO 2026-07-11 —
│   │                  # onboarding vive no módulo institutions; GET/interfaces/flags ficam)
│   ├── core/          # Tenant info & setup (GET /api/core/menus lê tb_interface)
│   └── erp/           # ERP module stub
├── feature-flags/     # Feature flag system
│   ├── flag.service.ts      # In-memory cache with TTL
│   └── flag.repository.ts   # DB queries
├── migrations/        # Database schema management
├── shared/
│   ├── db/connection.ts     # MySQL pool (decimalNumbers: true — NUNCA remover)
│   ├── address/             # peça independente: tb_address (types/dto/repository —
│   │                        # syncAddresses/listAddresses; recebe conn + entityId)
│   ├── phone/               # peça independente: tb_phone (syncPhones/listPhones)
│   ├── social-media/        # peça independente: tb_social_media
│   ├── fiscal/              # peça independente: tb_person × tb_company (upsertFiscal,
│   │                        # getPerson/getCompany)
│   ├── entity/              # tb_entity + entity-fiscal.ts (COMPOSIÇÃO da cadeia de
│   │                        # entidade fiscal: saveEntityFiscalChain, getEntityFiscalFull,
│   │                        # entityFiscalBody+withFiscalRefinements) + index.ts (barrel
│   │                        # '@shared/entity'); peças NUNCA importam entity/ — só a
│   │                        # composição importa as peças; concretos consomem o barrel
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
- Módulos legados (admin, core, erp) ainda usam Repository → Service → Routes
  sem controller/dto separados — migrar quando forem tocados

## Authentication & Authorization

### JWT (Client Apps)

All `/api/*` routes require JWT in header:
```
Authorization: Bearer <jwt_token>
```

**Payload shape** (`InstitutionPayload` em `src/shared/types/express.d.ts`; PADROES_BANCO §7):
```typescript
{ institutionId: number, userId: number, role: string, schemaName: string }   // role: super | admin | user …
```

**Assinatura RS256 com `kid`** (D-F13 — F2a, etapa A2, 2026-10-12): peça ÚNICA `@shared/auth/product-token`
(assina e verifica; token FINAL × token de SELEÇÃO com marca própria; `exp` obrigatório). O setes-api tem a chave
PRIVADA; nfse-api/nfe-api só a PÚBLICA. HS256/`JWT_SECRET` aposentados — sem a chave o boot NÃO sobe. Testes assinam
pelo `testToken` (`src/test-setup/test-token.ts`; par de TESTE gerado pelo setup do jest). NUNCA segredo em script versionado.

**Licença × privilégio** (D-F37): as guardas de ação (`@shared/auth/require-privilege`) conferem a interface CONTRATADA
para TODOS; super/admin passam só o privilégio.

### Recuperação de senha, aviso ao dono e SMTP (Q-PV38 / D-RS4 / D-RS5 — 2026-10-18/21)

`POST /auth/recovery-password` + `/auth/change-password` com o PEDIDO DE TROCA DE SENHA em `setes_central.tb_user_password_reset`
(sql/67 — o boot NÃO sobe sem a tabela): 5 erradas esgotam o código, 3/h e 10/24 h por conta, resposta neutra com piso de 400 ms,
código como HMAC. **D-RS4**: quando um código esgota ou o teto é atingido, o DONO recebe e-mail neutro (no máximo 1/h — fato na irmã
`tb_user_password_reset_notice`, também do sql/67). **D-RS5**: em PRODUÇÃO (`NODE_ENV=production`) o SMTP é OBRIGATÓRIO — o boot
recusa subir sem `SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_FROM` completos (`assertMailerReady`); em dev sem SMTP o código vai
ao LOG. Valores reais só no `.env` vivo (Valdo). Pré-voo: `scripts/pre-deploy-tz-check.ts` confere config + conexão SMTP sem enviar.
Detalhes: `Infra-IA/prompts/prompt_privilegios_interfaces.md` §13 (§13.8 publicação, §13.10 execução de 2026-10-21).

### Senha perdida do SUPER — procedimento do OPERADOR (D-PV46, 2026-10-20; exceção explícita — PADROES §3.1)

Nenhuma porta HTTP redefine a senha do Super (o admin não troca a senha do super — D-PV12; com DOIS Supers ativos, um define a do outro
pela tela de Usuários do Super). Quando NÃO resta outro Super ativo e o e-mail de recuperação não resolve, o operador roda NO SERVIDOR,
com o `.env` do destino:

```bash
npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts          # ENSAIO: lista o(s) Super(s), nada gravado
npx tsx --require tsconfig-paths/register scripts/reset-super-password.ts --vai    # redefine (1 Super ativo); --user-id/--email nomeiam o alvo
```

O script gera senha inicial aleatória (16 caracteres), grava com o MESMO hash do login pela peça do auth (sob a trava da linha do usuário —
mata o código de recuperação aberto), **imprime a senha UMA vez** no terminal (nunca em log/arquivo/banco) e registra no LOG quem rodou
(usuário do SO + host), quando e o id do Super; `tb_user.updated_at` recebe o instante (`tb_user` não tem `updated_by`). Recusa qualquer
conta que não seja Super (vínculo `kind='super'` na institution 1), Super inativo e 2+ Supers ativos. Entregar a senha ao titular por canal
seguro; ele define a própria em seguida. Roteiro de operação definitivo nasce com a Onda 4 (deploy) — até lá, esta nota.

### Chave do Sincronizador

O módulo `institutions` ADMINISTRA a `setes_central.tb_sync_api_key` (emissão da
chave por institution — D12), mas quem CONSOME a chave é o setes-sync. Nenhuma
rota deste projeto autentica por X-Api-Key.

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

## Rate Limiting

Uses `express-rate-limit` with **per-tenant keying**:
- **Window**: 60 seconds
- **Max requests**: 300 per tenant
- **Anonymous/unauthenticated**: Falls back to IP address

## Environment Variables

```bash
PORT=3000
JWT_PRIVATE_KEY_PATH=./secrets/jwt/setes-api.private.pem   # RS256 (D-F13) — ver .env.example
JWT_KID=default
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

**Debugging requests**:
- Check `src/shared/logger/logger.ts` — log middleware calls and errors
- Verify `req.tenant` is set after auth middleware
- Check feature flags cache with `FLAG_CACHE_TTL_MS`

## Key Files to Know

| File | Purpose |
|------|---------|
| `src/app.ts` | Express setup, middleware order, JWT routing |
| `src/gateway/router.ts` | All `/api/*` route registrations |
| `src/shared/db/connection.ts` | MySQL pool and schema switching |
| `src/shared/types/express.d.ts` | `req.tenant` type definitions |
| `.env.example` | Template for all environment variables |
