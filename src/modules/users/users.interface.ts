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
}

export interface UserRow {
  id:          number
  nameCompany: string | null
  nickTrade:   string | null
  email:       string | null
  active:      'S' | 'N'
}

export interface UserInput {
  nameCompany: string
  nickTrade:   string
  email:       string
  /** null/ausente no PUT = mantém a senha atual. */
  password?:   string | null
  active:      'S' | 'N'
}

/**
 * POST pode já vincular a uma institution (workflow 2026-07-12):
 * super → institutionId do body (aba Usuários do Estabelecimento);
 * admin do cliente → SEMPRE a institution do JWT (o service força).
 */
export interface UserCreateInput extends UserInput {
  institutionId?: number | null
  kind?:          string | null   // perfil do vínculo (default 'user')
}

/** Quem opera o cadastro (derivado do JWT no controller). */
export interface UserScope {
  isSuper:       boolean
  institutionId: number
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
