import { describe, expect, it } from 'vitest'
import {
  albumAlbums, albumPerson, albumPhotos, albumUpload,
  vofficeList, vofficeOpen, vofficeRename, vofficeUpload,
} from '../src/client/meta.ts'

const photoMeta = {
  kind: 'album.search',
  total: 2,
  query: 'sunset',
  photos: [
    { id: 'a1', filename: 'a.jpg', takenAt: '2025-07-18', city: '三亚', type: 'image', favorite: false, thumbPath: '/w/album-thumbs/a1-preview.jpg' },
    { id: 'a2', filename: 'b.jpg', takenAt: '', city: '', type: 'video', favorite: true, thumbPath: '/w/album-thumbs/a2-preview.jpg' },
  ],
}

describe('voffice card metadata', () => {
  it('narrows a list result and rejects foreign kinds', () => {
    const value = {
      kind: 'voffice.list', total: 2,
      files: [
        { name: 'a.docx', size: 12, modified: 100, viewUrl: 'https://host/open' },
        { name: 'b.xlsx', size: 3, modified: 200 },
      ],
    }
    expect(vofficeList(value)).toEqual({
      total: 2,
      files: [
        { name: 'a.docx', size: 12, modified: 100, viewUrl: 'https://host/open' },
        { name: 'b.xlsx', size: 3, modified: 200 },
      ],
    })
    expect(vofficeList({ kind: 'album.search' })).toBeNull()
    expect(vofficeList({ kind: 'voffice.list', files: 'nope' })).toBeNull()
    expect(vofficeList(null)).toBeNull()
  })

  it('narrowss open, rename, and upload results and rejects malformed rows', () => {
    expect(vofficeOpen({ kind: 'voffice.open', name: 'a', url: 'https://e', canWrite: true, expiresIn: 600 }))
      .toEqual({ name: 'a', url: 'https://e', canWrite: true, expiresIn: 600 })
    expect(vofficeOpen({ kind: 'voffice.open', name: 'a', url: '', canWrite: false, expiresIn: 600 })).toBeNull()

    expect(vofficeRename({ kind: 'voffice.rename', from: 'a', to: 'b' })).toEqual({ from: 'a', to: 'b' })
    expect(vofficeRename({ kind: 'voffice.rename', from: '', to: 'b' })).toBeNull()

    expect(vofficeUpload({ kind: 'voffice.upload', name: 'a', size: 5 })).toEqual({ name: 'a', size: 5 })
    expect(vofficeUpload({ kind: 'voffice.upload', name: '', size: 5 })).toBeNull()
  })
})

describe('album card metadata', () => {
  it('narrows a photo grid result with its query and totals', () => {
    const model = albumPhotos(photoMeta)
    expect(model).not.toBeNull()
    expect(model?.kind).toBe('album.search')
    expect(model?.total).toBe(2)
    expect(model?.photos[0]).toMatchObject({ id: 'a1', city: '三亚', type: 'image' })
    expect(model?.photos[1]).toMatchObject({ id: 'a2', type: 'video', favorite: true })
  })

  it('declines malformed photo rows instead of rendering a partial grid', () => {
    expect(albumPhotos({ kind: 'album.search', photos: [{ id: 'a1' }] })).toBeNull()
    expect(albumPhotos({ kind: 'album.search', photos: 'nope' })).toBeNull()
    expect(albumPhotos({ kind: 'voffice.list' })).toBeNull()
    expect(albumPhotos(undefined)).toBeNull()
  })

  it('narrows person, albums, and upload results', () => {
    expect(albumPerson({ kind: 'album.person', name: '朵朵', people: [{ id: 'p1', name: '朵朵', assets: 3 }] }))
      .toEqual({ name: '朵朵', people: [{ id: 'p1', name: '朵朵', assets: 3 }] })
    expect(albumPerson({ kind: 'album.person', people: 'nope' })).toBeNull()

    expect(albumAlbums({ kind: 'album.albums', albums: [{ id: 'al', name: '旅行', assets: 9 }] }))
      .toEqual({ albums: [{ id: 'al', name: '旅行', assets: 9 }] })
    expect(albumAlbums({ kind: 'album.albums', albums: [{ nope: true }] })).toBeNull()

    expect(albumUpload({ kind: 'album.upload', id: 'x', name: 'a.png', duplicate: true }))
      .toEqual({ id: 'x', name: 'a.png', duplicate: true })
    expect(albumUpload({ kind: 'album.upload', id: '', name: 'a.png' })).toBeNull()
  })
})
