import { describe, expect, it } from 'vitest'
import {
  albumAlbums, albumPerson, albumPhotos, albumUpload, imageStudio,
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

describe('image studio card metadata', () => {
  it('narrows a generated job and rejects rows without a file path', () => {
    const value = {
      kind: 'image.studio', job_id: 'job_1', status: 'succeeded', seed: 42, directory: '/w/out',
      files: [{ path: '/w/out/00001.png', filename: '00001.png', bytes: 1024 }],
    }
    expect(imageStudio(value)).toEqual({
      jobId: 'job_1', status: 'succeeded', seed: 42,
      files: [{ path: '/w/out/00001.png', filename: '00001.png', bytes: 1024 }],
    })
    expect(imageStudio({ kind: 'image.studio', files: [{ filename: 'a.png' }] })).toBeNull()
    expect(imageStudio({ kind: 'image.studio', files: 'nope' })).toBeNull()
    expect(imageStudio(undefined)).toBeNull()
  })
})
