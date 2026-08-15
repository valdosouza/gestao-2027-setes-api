import { Router } from 'express'
import coreRoutes  from '@modules/core/core.routes'
import erpRoutes   from '@modules/erp/erp.routes'
import adminRoutes from '@modules/admin/admin.routes'
import countriesRoutes     from '@modules/countries/countries.routes'
import institutionsRoutes  from '@modules/institutions/institutions.routes'
import statesRoutes     from '@modules/states/states.routes'
import citiesRoutes     from '@modules/cities/cities.routes'
import interfacesRoutes from '@modules/interfaces/interfaces.routes'
import privilegesRoutes from '@modules/privileges/privileges.routes'
import cfopRoutes from '@modules/cfop/cfop.routes'
import interfaceFieldsRoutes from '@modules/interface-fields/interface-fields.routes'
import interfaceConfigsRoutes from '@modules/interface-configs/interface-configs.routes'
import usersRoutes from '@modules/users/users.routes'
import entitiesRoutes from '@modules/entities/entities.routes'
import customersRoutes from '@modules/customers/customers.routes'
import collaboratorsRoutes from '@modules/collaborators/collaborators.routes'
import salesmenRoutes from '@modules/salesmen/salesmen.routes'
import carriersRoutes from '@modules/carriers/carriers.routes'
import providersRoutes from '@modules/providers/providers.routes'
import categoriesRoutes from '@modules/categories/categories.routes'
import financialPlansRoutes from '@modules/financial-plans/financial-plans.routes'
import paymentTypesRoutes from '@modules/payment-types/payment-types.routes'
import contractsRoutes from '@modules/contracts/contracts.routes'
import bankAccountsRoutes from '@modules/bank-accounts/bank-accounts.routes'
import serviceOrdersRoutes from '@modules/service-orders/service-orders.routes'
import settlementsRoutes from '@modules/settlements/settlements.routes'
import banksRoutes from '@modules/banks/banks.routes'
import modulesRoutes from '@modules/modules/modules.routes'
import { superGuard, superWriteGuard } from './super.guard'
import { adminGuard } from './admin.guard'

const router = Router()

router.use('/core',  coreRoutes)
router.use('/erp',   erpRoutes)
router.use('/admin', adminRoutes)

// Cadastros: 1 módulo = 1 rota raiz /api/<modulo>, espelho de /home/<modulo>
// no app (decisão do Valdo, 2026-07-11 — a URL segue o módulo, não o
// agrupador de menu). O guard vai POR MÓDULO: os cadastros do catálogo
// central são do Super (isSuper); cadastros de cliente terão guard próprio.
// Geográficos (fix 2026-07-18): leitura ABERTA a qualquer autenticado — os
// lookups da aba Endereços (país/UF/cidade) rodam em telas de CLIENTE
// (customers/collaborators/...); manutenção continua exclusiva do Super.
router.use('/countries',  superWriteGuard, countriesRoutes)
router.use('/states',     superWriteGuard, statesRoutes)
router.use('/cities',     superWriteGuard, citiesRoutes)
router.use('/interfaces', superGuard, interfacesRoutes)
router.use('/privileges', superGuard, privilegesRoutes)
// CFOP (2026-07-18): referência fiscal do catálogo CENTRAL — módulo Super.
router.use('/cfop',       superGuard, cfopRoutes)
// Bancos (2026-08-04, fecho da decisão 8 da Fase 3): catálogo FEBRABAN
// CENTRAL, cadastro geral SEM cadeia fiscal — manutenção do Super; o
// consumo pelos clientes segue no lookup /api/bank-accounts/banks.
router.use('/banks',      superGuard, banksRoutes)
router.use('/institutions', superGuard, institutionsRoutes)
// Usuários (workflow 2026-07-12): super gerencia qualquer institution
// (aba Usuários do Estabelecimento); ADMIN do cliente gerencia os do
// PRÓPRIO institution (módulo Sistema) — escopo forçado no service.
router.use('/users',        adminGuard, usersRoutes)
// Módulos de menu do cliente (prompt_modulo_menus.md D1/D2, 2026-08-04):
// camada 2 do menu ganha escrita — adminGuard (personalizar o menu é ação
// administrativa); escopo = schema do JWT; flag 'modules'.
router.use('/modules',      adminGuard, modulesRoutes)

// Painel de campos configuráveis (Fase 2, decisões 6 e 9): módulo do CLIENTE
// (sem superGuard — privilégio da tela no app) e isento do gate de flags
// (o GET resolvido é infraestrutura de montagem de toda tela, como o core).
router.use('/interface-fields', interfaceFieldsRoutes)

// Painel de configurações do sistema (Framework de Configurações, decisões
// 7 e 9): módulo do CLIENTE no molde do interface-fields — sem superGuard
// (admin × usuário decidido no service) e isento do gate de flags (o GET
// resolvido por chave é infraestrutura de montagem de tela). O CRUD do
// CATÁLOGO vive em /api/interfaces/:id/configs (superGuard).
router.use('/interface-configs', interfaceConfigsRoutes)

// Busca por documento (Fase 3 Entidade Única, decisões 3 e 10): aberta a
// QUALQUER usuário autenticado — o prefill compartilhado é a feature; isenta
// do gate de flags (infraestrutura dos cadastros da cadeia fiscal).
router.use('/entities', entitiesRoutes)

// Clientes (Fase 3, decisão 8 — 1º cadastro do CLIENTE com a cadeia fiscal):
// sem superGuard — privilégio da tela é do app (decisão 21); escopo por
// institution forçado no service via JWT; gate técnico = flag 'customers'.
router.use('/customers', customersRoutes)

// Colaboradores (onda 2 da Entidade Única — hierarquia de papéis, decisão
// 16): mesmo desenho do customers — sem superGuard (privilégio da tela é do
// app); escopo por institution no service; gate técnico = flag 'collaborators'.
router.use('/collaborators', collaboratorsRoutes)

// Vendedores (Onda 2 — prompt_onda2_salesman_carrier.md, D1/D5): PROMOÇÃO de
// colaborador (precedência por construção — o novo nasce do
// collaborator-lookup); mesmo desenho do customers; flag 'salesmen'.
router.use('/salesmen', salesmenRoutes)

// Transportadoras (Onda 2 — D2): cadeia fiscal completa + aba Tributação;
// mesmo desenho do customers; flag 'carriers'.
router.use('/carriers', carriersRoutes)

// Fornecedores (Onda 3 — prompt_onda3_provider.md, D1): cadeia fiscal
// completa + aba Tributação; mesmo desenho do carriers; flag 'providers'.
router.use('/providers', providersRoutes)

// Categorias de produtos/serviços (2026-07-18): cadastro de CLIENTE — sem
// superGuard; escopo por institution no service; flag 'categories'.
router.use('/categories', categoriesRoutes)

// Plano de contas (2026-07-18): 2º cadastro em ÁRVORE — mesmo desenho do
// categories; escopo por institution no service; flag 'financial-plans'.
router.use('/financial-plans', financialPlansRoutes)

// Formas de pagamento (2026-07-18): catálogo CENTRAL compartilhado (cliente
// inicia o cadastro) + vínculo por institution — grupo Financeiro; flag
// 'payment-types'.
router.use('/payment-types', paymentTypesRoutes)

// Contratos de serviço (Módulo Software House, 2026-07-18): cadastro de
// CLIENTE — sem superGuard; escopo por institution no service; flag
// 'contracts'. Base da rotina mensal de faturamento (ondas futuras).
router.use('/contracts', contractsRoutes)

// Parcerias (Parceria v2, 2026-07-19): o standalone foi APOSENTADO — a
// parceria é ANGARIAÇÃO e vive na ABA Parceria do cliente
// (GET/PUT /api/customers/:id/partnership; tb_partnership FLAT).

// Contas bancárias (Software House, 5.6): cadastro de CLIENTE — grupo
// Financeiro; catálogo central tb_bank (DP2); flag 'bank-accounts'.
router.use('/bank-accounts', bankAccountsRoutes)

// Ordens de serviço (Software House, 4.4–4.6): 1ª TELA DE PROCESSO —
// grupo Serviços; ciclo mensal + Gerar Faturamento; flag 'service-orders'.
router.use('/service-orders', serviceOrdersRoutes)

// Baixa de títulos/estorno/movimento (Software House, 5.5/Fase 6): tela
// de PROCESSO do financeiro — imutável (lançamento inverso + N/E/R);
// flag 'settlements'.
router.use('/settlements', settlementsRoutes)

export default router
