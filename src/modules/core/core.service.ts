import fs   from 'fs'
import path from 'path'
import {
  getInstitutionInfo,
  getPreferences, upsertPreference,
  getTheme, upsertTheme,
  getModuleInterfaces, getUngroupedInterfaces,
  getUserPrivileges, getAllInterfacePrivileges,
  MenuInterfaceRow,
} from './core.repository'
import { InstitutionPayload } from '@shared/types/express'
import { isSuper } from '@shared/auth/roles'
import { HttpError } from '@shared/errors/http-error'

export async function getInstitutionData(schemaName: string) {
  const institution = await getInstitutionInfo(schemaName)
  if (!institution) throw new Error('Institution não encontrada')
  return institution
}

// ---------------------------------------------------------------------
// Preferências do usuário (decisão 14) — primeira chave: 'locale'
// Institution padrão NÃO entra aqui (fica local no dispositivo — decisão 15)
// ---------------------------------------------------------------------

export async function getUserPreferences(userId: number): Promise<Record<string, string>> {
  return getPreferences(userId)
}

export async function setUserPreference(userId: number, key: string, value: string): Promise<void> {
  await upsertPreference(userId, key, value)
}

// ---------------------------------------------------------------------
// Tema por institution (decisão 16)
// Logomarca: arquivo em storage servido pela API — nunca BLOB.
// ---------------------------------------------------------------------

const STORAGE_PATH  = process.env.STORAGE_PATH ?? path.resolve(process.cwd(), 'storage')
const MAX_LOGO_SIZE = 1_500_000 // ~1,5 MB decodificado

export interface ThemeData {
  primaryColor:   string | null
  secondaryColor: string | null
  logoBase64:     string | null // data URI pronto para a UI
}

export async function getInstitutionTheme(institutionId: number): Promise<ThemeData> {
  const row = await getTheme(institutionId)
  if (!row) return { primaryColor: null, secondaryColor: null, logoBase64: null }

  let logoBase64: string | null = null
  if (row.logoPath) {
    const full = path.join(STORAGE_PATH, row.logoPath)
    if (fs.existsSync(full)) {
      const ext  = path.extname(full).replace('.', '') || 'png'
      logoBase64 = `data:image/${ext};base64,${fs.readFileSync(full).toString('base64')}`
    }
  }
  return { primaryColor: row.primaryColor, secondaryColor: row.secondaryColor, logoBase64 }
}

export interface ThemeInput {
  primaryColor?:   string
  secondaryColor?: string
  logoBase64?:     string // data URI (data:image/png;base64,...)
}

export async function setInstitutionTheme(institutionId: number, input: ThemeInput): Promise<void> {
  let logoPath: string | null = null

  if (input.logoBase64) {
    const match = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,(.+)$/.exec(input.logoBase64)
    if (!match) throw new HttpError(400, 'logoBase64 deve ser um data URI de imagem (png/jpeg/webp/svg)')

    const ext    = match[1] === 'svg+xml' ? 'svg' : match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    if (buffer.length > MAX_LOGO_SIZE) throw new HttpError(413, 'Logomarca excede o tamanho máximo (1,5 MB)')

    const dir = path.join(STORAGE_PATH, 'logos')
    fs.mkdirSync(dir, { recursive: true })
    logoPath = path.join('logos', `institution_${institutionId}.${ext}`)
    fs.writeFileSync(path.join(STORAGE_PATH, logoPath), buffer)
  }

  await upsertTheme(institutionId, {
    primaryColor:   input.primaryColor ?? null,
    secondaryColor: input.secondaryColor ?? null,
    logoPath,
  })
}

// ---------------------------------------------------------------------
// Menus dinâmicos (decisões 18 e 21): árvore módulos → interfaces →
// privilégios, já filtrada pelo usuário — o app só renderiza.
// Superusuário (institution 1, role 'super') enxerga tudo (decisão 14 Fase 2).
// ---------------------------------------------------------------------

export interface MenuInterface {
  id:           number
  description:  string | null
  buttonAction: string | null
  imgIndex:     number | null
  privileges:   string[]
}

export interface MenuModule {
  module: { id: number | null; description: string | null; icon: number | null }
  interfaces: MenuInterface[]
}

export async function getMenus(payload: InstitutionPayload): Promise<MenuModule[]> {
  const superUser = isSuper(payload)
  const { schemaName, userId } = payload

  const [inModules, ungrouped, privileges] = await Promise.all([
    getModuleInterfaces(schemaName, userId, superUser),
    getUngroupedInterfaces(schemaName, userId, superUser),
    superUser ? getAllInterfacePrivileges() : getUserPrivileges(schemaName, userId),
  ])

  const privMap = new Map<number, string[]>()
  for (const p of privileges) {
    if (!privMap.has(p.interfaceId)) privMap.set(p.interfaceId, [])
    if (p.description) privMap.get(p.interfaceId)!.push(p.description)
  }

  const modules = new Map<string, MenuModule>()
  const add = (row: MenuInterfaceRow) => {
    const key = row.moduleId !== null ? `m:${row.moduleId}` : `g:${row.moduleDescription ?? 'Geral'}`
    if (!modules.has(key)) {
      modules.set(key, {
        module: { id: row.moduleId, description: row.moduleDescription ?? 'Geral', icon: row.moduleIcon },
        interfaces: [],
      })
    }
    modules.get(key)!.interfaces.push({
      id:           row.interfaceId,
      description:  row.interfaceDescription,
      buttonAction: row.buttonAction,
      imgIndex:     row.imgIndex,
      privileges:   privMap.get(row.interfaceId) ?? [],
    })
  }

  inModules.forEach(add)
  ungrouped.forEach(add)

  return Array.from(modules.values())
}
