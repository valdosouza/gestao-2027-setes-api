/// <reference types="jest" />
// Árvore de categorias (porta do reg_category.pas; decisões do Valdo
// 2026-07-18): matemática do posit_level materializado, regras de mover
// (ciclo proibido) e exclusão bloqueada com subníveis.
import {
  pathSegment, childPath, parentIdFromPath, isSelfOrDescendant,
} from '../modules/categories/categories.path'
import { resolveMovedPath, removeCategory } from '../modules/categories/categories.service'
import * as repo from '../modules/categories/categories.repository'

jest.mock('../modules/categories/categories.repository')

const mockGet         = repo.getCategory    as jest.Mock
const mockHasChildren = repo.hasChildren    as jest.Mock
const mockDelete      = repo.deleteCategory as jest.Mock

const scope = { schemaName: 'setes_acme', institutionId: 7 }

beforeEach(() => jest.clearAllMocks())

describe('caminho materializado (posit_level)', () => {
  it('segmento com 3 dígitos (acima de 999 imprime inteiro — como o Delphi)', () => {
    expect(pathSegment(7)).toBe('007')
    expect(pathSegment(123)).toBe('123')
    expect(pathSegment(1234)).toBe('1234')
  })

  it('caminho do filho = pai + código; raiz = só o código', () => {
    expect(childPath(null, 5)).toBe('005')
    expect(childPath('001', 5)).toBe('001.005')
    expect(childPath('001.005', 12)).toBe('001.005.012')
  })

  it('pai derivado do caminho (null = raiz)', () => {
    expect(parentIdFromPath('001')).toBeNull()
    expect(parentIdFromPath('001.005')).toBe(1)
    expect(parentIdFromPath('001.005.012')).toBe(5)
    expect(parentIdFromPath(null)).toBeNull()
  })

  it('detecção de descendente (proíbe ciclo)', () => {
    expect(isSelfOrDescendant('001', '001')).toBe(true)
    expect(isSelfOrDescendant('001', '001.005')).toBe(true)
    expect(isSelfOrDescendant('001', '002')).toBe(false)
    expect(isSelfOrDescendant('001', '0010')).toBe(false) // prefixo ≠ segmento
  })
})

describe('resolveMovedPath (mover de pai — decisão do Valdo)', () => {
  it('pai igual ao atual = não move (null)', () => {
    expect(resolveMovedPath(5, 1)('001.005', '001')).toBeNull()
    expect(resolveMovedPath(5, null)('005', null)).toBeNull()
  })

  it('mover para outro pai recalcula o caminho', () => {
    expect(resolveMovedPath(5, 2)('001.005', '002')).toBe('002.005')
  })

  it('mover para a raiz', () => {
    expect(resolveMovedPath(5, null)('001.005', null)).toBe('005')
  })

  it('não pode ser filha dela mesma', () => {
    expect(() => resolveMovedPath(5, 5)('001.005', '001.005'))
      .toThrow('Movimento inválido')
  })

  it('não pode mover para um descendente', () => {
    expect(() => resolveMovedPath(1, 12)('001', '001.005.012'))
      .toThrow('Movimento inválido')
  })
})

describe('removeCategory (exclusão bloqueada com subníveis)', () => {
  const node = {
    id: 5, description: 'Bebidas', positLevel: '001.005',
    parentId: 1, kind: 'P', active: 'S',
  }

  it('com subníveis: 409 e NÃO exclui', async () => {
    mockGet.mockResolvedValue(node)
    mockHasChildren.mockResolvedValue(true)

    await expect(removeCategory(5, scope))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('folha: exclui (soft delete)', async () => {
    mockGet.mockResolvedValue(node)
    mockHasChildren.mockResolvedValue(false)

    await removeCategory(5, scope)
    expect(mockDelete).toHaveBeenCalledWith(5, 'setes_acme', 7)
  })
})
