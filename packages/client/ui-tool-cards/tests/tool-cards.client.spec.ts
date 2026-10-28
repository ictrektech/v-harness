import { describe, expect, it } from 'vitest'
import { imageStudio } from '../src/client/meta.ts'

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
