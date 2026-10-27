/**
 * Tipos do módulo users — cadastro de Usuário (autenticação).
 * Shapes camelCase que o app consome (contrato da casa).
 *
 * O cadastro grava a CADEIA DO LOGIN (análise do módulo auth, 2026-07-12):
 * tb_entity (nome, herança por PK) + tb_user (senha MD5/active) +
 * tb_mailing × tb_entity_has_mailing GRUPO 2 'sistema' (email de login) +
 * tb_institution_has_user (vínculos — sem vínculo ativo o login dá 403).
 */

export interface UserListRow {
  id:     number
  name:   string | null   // nick_trade (fallback name_company)
  email:  string | null   // email de login (grupo 2)
  active: 'S' | 'N'
  /** Perfil do vínculo com o institution do filtro (null sem filtro). */
  kind:   string | null
}

export interface UserRow {
  id:          number
  nameCompany: string | null
  nickTrade:   string | null
  email:       string | null
  /**
   * D-PV19/D-UC2 (2026-10-20): "ativo" é do VÍNCULO `tb_institution_has_user.active` com o estabelecimento em FOCO (admin = o do
   * JWT; super = `?institutionId`). Sem foco (super na tela global) vem `null` — a credencial em si nunca se inativa pelo cadastro.
   */
  active:      'S' | 'N' | null
}

export interface UserInput {
  nameCompany: string
  nickTrade:   string
  /** D-PV19/D-UC1: o e-mail de LOGIN é imutável — no PUT tem de ser o atual (409 LOGIN_EMAIL_IMMUTABLE se diferir). */
  email:       string
  /** null/ausente no PUT = mantém a senha atual. */
  password?:   string | null
  /** D-PV19/D-UC2: ativo do VÍNCULO com o estabelecimento alvo; ausente no PUT = não mexe. */
  active?:     'S' | 'N'
}

/** PUT: o alvo do "ativo" — super informa `institutionId`; admin tem o alvo forçado ao JWT. */
export interface UserUpdateInput extends UserInput {
  institutionId?: number | null
}

/**
 * POST pode já vincular a uma institution (workflow 2026-07-12):
 * super → institutionId do body (aba Usuários do Estabelecimento);
 * admin do cliente → SEMPRE a institution do JWT (o service força).
 */
export interface UserCreateInput extends UserInput {
  /** Na criação o ativo da credencial é obrigatório (o DTO dá 'S' por padrão); o vínculo nasce vivo. */
  active:         'S' | 'N'
  institutionId?: number | null
  kind?:          string | null   // perfil do vínculo (default 'user')
}

/** Quem opera o cadastro (derivado do JWT no controller). */
/** Linha do lookup de instituições do critério "instituição" (só Super — D-BA24). */
export interface InstitutionLookupRow {
  id:   number
  name: string | null
}

export interface UserScope {
  isSuper:       boolean
  institutionId: number
  schemaName:    string
}

/** Um privilégio do catálogo da interface + situação da concessão ao usuário. */
export interface UserPrivilegeGrant {
  privilegeId: number
  description: string | null
  granted:     'S' | 'N'
}

/**
 * Linha da tela de privilégios (workflow ACL 2026-07-12): interface
 * CONTRATADA pelo institution alvo, com os privilégios definidos no
 * catálogo (tb_interface_has_privilege) e a concessão ao usuário
 * (tb_user_has_privilege no schema do cliente).
 */
export interface UserInterfacePrivileges {
  interfaceId:  number
  description:  string | null
  i18nKey:      string | null
  groupDefault: string | null
  /** Módulos do cliente que contêm a interface — filtro da tela. */
  moduleNames:  string | null
  privileges:   UserPrivilegeGrant[]
}

/** Linha da seção Estabelecimentos: catálogo + situação do vínculo. */
export interface UserInstitutionGrant {
  institutionId: number
  name:          string | null   // nick_trade da institution
  schemaName:    string
  /** Perfil do usuário NESTA institution (vira o role do JWT). */
  kind:          string | null
  granted:       'S' | 'N'
}

/** Entrada do PUT de vínculos (sincroniza: concede a lista, revoga as demais). */
export interface UserInstitutionLink {
  institutionId: number
  kind:          string
}
