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
import serviceListRoutes from '@modules/service-list/service-list.routes'
import interfaceFieldsRoutes from '@modules/interface-fields/interface-fields.routes'
import interfaceConfigsRoutes from '@modules/interface-configs/interface-configs.routes'
import usersRoutes from '@modules/users/users.routes'
import entitiesRoutes from '@modules/entities/entities.routes'
import customersRoutes from '@modules/customers/customers.routes'
import collaboratorsRoutes from '@modules/collaborators/collaborators.routes'
import salesmenRoutes from '@modules/salesmen/salesmen.routes'
import carriersRoutes from '@modules/carriers/carriers.routes'
import providersRoutes from '@modules/providers/providers.routes'
import taxRulesRoutes from '@modules/tax-rules/tax-rules.routes'
import stateTaxRatesRoutes from '@modules/state-tax-rates/state-tax-rates.routes'
import billingRoutes from '@modules/billing/billing.routes'
import categoriesRoutes from '@modules/categories/categories.routes'
import financialPlansRoutes from '@modules/financial-plans/financial-plans.routes'
import paymentTypesRoutes from '@modules/payment-types/payment-types.routes'
import contractsRoutes from '@modules/contracts/contracts.routes'
import bankAccountsRoutes from '@modules/bank-accounts/bank-accounts.routes'
import settlementRulesRoutes from '@modules/settlement-rules/settlement-rules.routes'
import bankSlipsRoutes from '@modules/bank-slips/bank-slips.routes'
import bankChargeAgreementsRoutes from '@modules/bank-charge-agreements/bank-charge-agreements.routes'
import checksRoutes from '@modules/checks/checks.routes'
import serviceOrdersRoutes from '@modules/service-orders/service-orders.routes'
import settlementsRoutes from '@modules/settlements/settlements.routes'
import cashierRoutes from '@modules/cashier/cashier.routes'
import ordersRoutes from '@modules/orders/orders.routes'
import orderReturnsRoutes from '@modules/order-returns/order-returns.routes'
import banksRoutes from '@modules/banks/banks.routes'
import modulesRoutes from '@modules/modules/modules.routes'
import establishmentRoutes from '@modules/establishment/establishment.routes'
import servicesRoutes from '@modules/services/services.routes'
import priceListsRoutes from '@modules/price-lists/price-lists.routes'
import serviceTaxRulesRoutes from '@modules/service-tax-rules/service-tax-rules.routes'
import institutionInterfacesRoutes from '@modules/institution-interfaces/institution-interfaces.routes'
import { superGuard, superWriteGuard } from './super.guard'
import { adminGuard } from './admin.guard'
import { gatedModule } from '@shared/auth/module-privilege-gate'

const router = Router()

// D-PV2 (Valdo 2026-10-18 — prompt_privilegios_interfaces.md): todo módulo de tela do CLIENTE passa pela guarda de
// privilégio POR ROTEADOR (`gatedModule`): GET → VISUALIZAR, POST → INSERIR, PUT → ALTERAR, DELETE → EXCLUIR na interface
// do módulo; atos de processo e exceções declarados NA ROTA (`privilegeAct`/`openRoute`). Licença antes do privilégio
// (D-F37); o super passa as duas (A-PV1); admin passa o privilégio. FORA da guarda, por nome: core, erp, admin,
// entities (prefill de qualquer cadastro), billing/* (guardas de AÇÃO pela interface do RAMO — Q-G22), os geográficos
// (leitura aberta — referência dos endereços), os do Super (superGuard), users/establishment (perfil admin — D-PV5),
// modules (adminGuard até a onda 0 do grupo — D-GE20) e state-tax-rates (sem interface no catálogo — adminGuard, D-PV23).
// D-PV36: módulo sob `gatedModule` NÃO consulta mais a flag técnica (o vínculo de interfaces é a única licença).

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
// Lista de Servicos LC 116 (prompt_regra_tributacao_servico.md D10): referencia
// fiscal central da regra de tributacao de servico - Super.
router.use('/service-list', superGuard, serviceListRoutes)
// Bancos (2026-08-04, fecho da decisão 8 da Fase 3): catálogo FEBRABAN
// CENTRAL, cadastro geral SEM cadeia fiscal — manutenção do Super; o
// consumo pelos clientes segue no lookup /api/bank-accounts/banks.
router.use('/banks',      superGuard, banksRoutes)
router.use('/institutions', superGuard, institutionsRoutes)
// Interfaces dos clientes (D-PV11, Valdo 2026-10-18): o vínculo estabelecimento × interfaces de cada cliente — tela do grupo Super
// DELEGÁVEL a usuário da Setes, só pela liberação do Super (até o admin da Setes precisa do privilégio marcado); o Super passa
// sempre. A aba Interfaces do cadastro de Estabelecimento (`/api/admin`) segue só do Super — as duas pela mesma peça.
router.use('/institution-interfaces', ...gatedModule('institution-interfaces', institutionInterfacesRoutes, { delegatedSuper: true }))
// Usuários (workflow 2026-07-12): super gerencia qualquer institution
// (aba Usuários do Estabelecimento); ADMIN do cliente gerencia os do
// PRÓPRIO institution (módulo Sistema) — escopo forçado no service.
router.use('/users',        adminGuard, usersRoutes)
// Módulos de menu do cliente (prompt_modulo_menus.md D1/D2, 2026-08-04):
// camada 2 do menu ganha escrita — adminGuard (personalizar o menu é ação
// administrativa); escopo = schema do JWT; flag 'modules'.
router.use('/modules',      adminGuard, modulesRoutes)
// Estabelecimento (autoatendimento do admin sobre o PRÓPRIO institution):
// adminGuard, SEM :id de rota — institutionId vem sempre do token (IDOR
// eliminado por construção). Telas estruturais: flag 'establishment'.
router.use('/establishment', adminGuard, establishmentRoutes)

// Painel de campos configuráveis (Fase 2, decisões 6 e 9): módulo do CLIENTE
// (sem superGuard) e isento do gate de flags (o GET resolvido é infraestrutura
// de montagem de toda tela, como o core — `openRoute` na rota /key). D-PV6: o
// salvar do campo passa a ser decidido pela guarda (PUT → ALTERAR).
router.use('/interface-fields', ...gatedModule('interface-fields', interfaceFieldsRoutes))

// Painel de configurações do sistema (Framework de Configurações, decisões
// 7 e 9): módulo do CLIENTE no molde do interface-fields — sem superGuard
// (admin × usuário decidido no service) e isento do gate de flags (o GET
// resolvido por chave é infraestrutura de montagem de tela). O CRUD do
// CATÁLOGO vive em /api/interfaces/:id/configs (superGuard).
router.use('/interface-configs', ...gatedModule('interface-configs', interfaceConfigsRoutes))

// Busca por documento (Fase 3 Entidade Única, decisões 3 e 10): aberta a
// QUALQUER usuário autenticado — o prefill compartilhado é a feature; isenta
// do gate de flags (infraestrutura dos cadastros da cadeia fiscal).
// D-PV23/D-PV30 (2026-10-20): as rotas AVULSAS de tributação (GET/PUT /:id/tax)
// SAÍRAM — a tributação se grava na transação do PAPEL (aba Tributação) e a
// do emitente pelo Meu Estabelecimento; sobrou só o prefill.
router.use('/entities', entitiesRoutes)

// Clientes (Fase 3, decisão 8 — 1º cadastro do CLIENTE com a cadeia fiscal):
// sem superGuard — privilégio da tela é do app (decisão 21); escopo por
// institution forçado no service via JWT; gate técnico = flag 'customers'.
router.use('/customers', ...gatedModule('customers', customersRoutes))

// Colaboradores (onda 2 da Entidade Única — hierarquia de papéis, decisão
// 16): mesmo desenho do customers — sem superGuard (privilégio da tela é do
// app); escopo por institution no service; gate técnico = flag 'collaborators'.
router.use('/collaborators', ...gatedModule('collaborators', collaboratorsRoutes))

// Vendedores (Onda 2 — prompt_onda2_salesman_carrier.md, D1/D5): PROMOÇÃO de
// colaborador (precedência por construção — o novo nasce do
// collaborator-lookup); mesmo desenho do customers; flag 'salesmen'.
router.use('/salesmen', ...gatedModule('salesmen', salesmenRoutes))

// Transportadoras (Onda 2 — D2): cadeia fiscal completa + aba Tributação;
// mesmo desenho do customers; flag 'carriers'.
router.use('/carriers', ...gatedModule('carriers', carriersRoutes))

// Fornecedores (Onda 3 — prompt_onda3_provider.md, D1): cadeia fiscal
// completa + aba Tributação; mesmo desenho do carriers; flag 'providers'.
router.use('/providers', ...gatedModule('providers', providersRoutes))

// Regras de Tributação (fase Faturamento Fiscal e Financeiro, decisões
// 1/23/28): cadastro de CLIENTE — seletor + peças por tributo (presença =
// incidência); o MATCH vive em @shared/tax-rule. Flag 'tax-rules'.
router.use('/tax-rules', ...gatedModule('tax-rules', taxRulesRoutes))

// Catálogo MVA/FCP por UF×NCM (W2 Onda 2, Rodada 3 do prompt de fase): dado
// FISCAL INTERPRETÁVEL do CLIENTE (decisão Q22 — sem compartilhamento entre
// institutions). Fonte do ICMS-ST/FCP que o motor @shared/tax-rule/calc.ts
// consome via resolveMvaAliq/resolveFcpAliq. Sem tela no app ainda (Q22 —
// onda do app desta fase); flag 'state-tax-rates'.
// D-PV23 (Valdo 2026-10-20, fecha a Q-PV14 = (a)): sem interface no catálogo a guarda por roteador não a alcança — até a
// tela nascer, escrita de dado fiscal só pelo perfil ADMIN (adminGuard); o super passa (A-PV1).
router.use('/state-tax-rates', adminGuard, stateTaxRatesRoutes)

// Faturamento de ordens (W2 Onda 3, rodada R4): /validate (lote completo de
// pendências + grava regra por item origin 'A') e /invoice (fatura consumindo
// as regras gravadas — impostos por item + nota + financeiro em UMA
// transação). Flag 'billing'. D-PV23: /validate também sob FATURAR pela
// interface do RAMO (mesmo resolvedor do /invoice) — grava regra por item.
router.use('/billing', billingRoutes)

// Categorias de produtos/serviços (2026-07-18): cadastro de CLIENTE — sem
// superGuard; escopo por institution no service; flag 'categories'.
router.use('/categories', ...gatedModule('categories', categoriesRoutes))

// Plano de contas (2026-07-18): 2º cadastro em ÁRVORE — mesmo desenho do
// categories; escopo por institution no service; flag 'financial-plans'.
router.use('/financial-plans', ...gatedModule('financial-plans', financialPlansRoutes))

// Formas de pagamento (2026-07-18): catálogo CENTRAL compartilhado (cliente
// inicia o cadastro) + vínculo por institution — grupo Financeiro; flag
// 'payment-types'.
router.use('/payment-types', ...gatedModule('payment-types', paymentTypesRoutes))

// Contratos de serviço (Módulo Software House, 2026-07-18): cadastro de
// CLIENTE — sem superGuard; escopo por institution no service; flag
// 'contracts'. Base da rotina mensal de faturamento (ondas futuras).
router.use('/contracts', ...gatedModule('contracts', contractsRoutes))

// Parcerias (Parceria v2, 2026-07-19): o standalone foi APOSENTADO — a
// parceria é ANGARIAÇÃO e vive na ABA Parceria do cliente
// (GET/PUT /api/customers/:id/partnership; tb_partnership FLAT).

// Contas bancárias (Software House, 5.6): cadastro de CLIENTE — grupo
// Financeiro; catálogo central tb_bank (DP2); flag 'bank-accounts'.
router.use('/bank-accounts', ...gatedModule('bank-accounts', bankAccountsRoutes))

// Regras de recebimento (política de baixa automática por forma de
// pagamento — migration 038, prompt_contrato_financeiro_baixa_automatica.md
// D1–D22): cadastro de CLIENTE, grupo Financeiro; flag 'settlement-rules'.
router.use('/settlement-rules', ...gatedModule('settlement-rules', settlementRulesRoutes))

// Boletos (tela de processo — migration 039, prompt_boleto_emitido.md
// D1–D11): emitir/liquidar/cancelar/estornar; flag 'bank-slips'.
router.use('/bank-slips', ...gatedModule('bank-slips', bankSlipsRoutes))

// Carteiras de cobrança (tb_bank_charge_agreement — contratação de cobrança
// com o banco; o boleto congela taxas/instruções daqui na emissão);
// flag 'bank-charge-agreements'.
router.use('/bank-charge-agreements', ...gatedModule('bank-charge-agreements', bankChargeAgreementsRoutes))

// Cheques (tela de processo — migration 040, prompt_cheque_
// rastreabilidade.md D1–D10 + D7a–c): depositar/descontar/retornar/pagar/
// devolver/estornar; R nasce no faturamento (/api/billing/invoice);
// flag 'checks'.
router.use('/checks', ...gatedModule('checks', checksRoutes))

// Serviços (prompt_modulo_services.md, D1–D7 2026-09-01): tb_product
// kind='S' fixo + grade de preços tb_price; tela irmã do futuro cadastro
// de produtos (D5/D6); flag 'services'. Tabelas de Preço = módulo próprio
// (D7); flag 'price-lists'.
router.use('/services', ...gatedModule('services', servicesRoutes))
router.use('/price-lists', ...gatedModule('price-lists', priceListsRoutes))
// Regra de Tributacao de SERVICO (ISS) — prompt_regra_tributacao_servico.md
// D1-D14: cidade de incidencia x item LC 116 -> aliquota + codigo municipal;
// caminho individual do servico (nada de @shared/tax-rule); flag 'service-tax-rules'.
router.use('/service-tax-rules', ...gatedModule('service-tax-rules', serviceTaxRulesRoutes))

// Ordens de serviço (Software House, 4.4–4.6): 1ª TELA DE PROCESSO —
// grupo Serviços; ciclo mensal + Gerar Faturamento; flag 'service-orders'.
router.use('/service-orders', ...gatedModule('service-orders', serviceOrdersRoutes))

// Baixa de títulos/estorno/movimento (Software House, 5.5/Fase 6): tela
// de PROCESSO do financeiro — imutável (lançamento inverso + N/E/R);
// flag 'settlements'.
router.use('/settlements', ...gatedModule('settlements', settlementsRoutes))

// Caixa (W3.2, parecer setes-conceito 2026-08-22): abertura/fechamento por
// dia+usuário+terminal=0 (web) + retirada/transferência; flag 'cashier'.
router.use('/cashier', ...gatedModule('cashier', cashierRoutes))

// Pedido de venda/conjugado (2026-08-22): tela de processo — grupo Vendas;
// flag 'orders'. Faturamento é do módulo billing (/validate + /invoice).
router.use('/orders', ...gatedModule('orders', ordersRoutes))
router.use('/order-returns', ...gatedModule('order-returns', orderReturnsRoutes))

export default router
