import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { google, type drive_v3 } from 'googleapis'

const IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'image/gif',
])

export class DriveConfigError extends Error {
  constructor(message = 'Google Drive is not configured') {
    super(message)
    this.name = 'DriveConfigError'
  }
}

type DriveClient = {
  drive: drive_v3.Drive
  folderId: string
}

let client: DriveClient | null = null

function apiRoot() {
  return path.resolve(import.meta.dirname, '..')
}

function repoRoot() {
  return path.resolve(apiRoot(), '..')
}

function parseFolderId(value: string) {
  const trimmed = value.trim()
  const fromUrl = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  return fromUrl?.[1] ?? trimmed
}

function resolveKeyFile(keyFile: string) {
  if (path.isAbsolute(keyFile)) return keyFile

  const candidates = [
    path.join(apiRoot(), keyFile),
    path.join(repoRoot(), keyFile),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function loadCredentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
  if (inline) return JSON.parse(inline) as Record<string, unknown>

  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  if (!keyFile) return null

  return JSON.parse(readFileSync(resolveKeyFile(keyFile), 'utf8')) as Record<
    string,
    unknown
  >
}

function getClient(): DriveClient {
  if (client) return client

  const folderRaw = process.env.GOOGLE_DRIVE_FOLDER_ID
  const credentials = loadCredentials()
  if (!folderRaw?.trim() || !credentials) {
    throw new DriveConfigError()
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  })

  client = {
    drive: google.drive({ version: 'v3', auth }),
    folderId: parseFolderId(folderRaw),
  }
  return client
}

function escapeQuery(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function isDriveId(id: string) {
  return /^[a-zA-Z0-9_-]{10,}$/.test(id)
}

function safeFileName(originalName: string, mimeType: string) {
  const extFromName = path.extname(originalName)
  const ext =
    extFromName ||
    {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'image/heif': '.heif',
      'image/gif': '.gif',
    }[mimeType] ||
    '.jpg'
  const base =
    path
      .basename(originalName, extFromName)
      .replace(/[^\w.-]+/g, '_')
      .slice(0, 80) || 'photo'
  return `${Date.now()}-${base}${ext}`
}

export function isAllowedImage(mimeType: string) {
  return IMAGE_TYPES.has(mimeType) || mimeType.startsWith('image/')
}

export async function listPhotos() {
  const { drive, folderId } = getClient()
  const result = await drive.files.list({
    q: `'${escapeQuery(folderId)}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id, name, createdTime)',
    orderBy: 'createdTime desc',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  return (result.data.files ?? []).flatMap((file) => {
    if (!file.id) return []
    return [
      {
        id: file.id,
        name: file.name ?? 'photo',
        url: `/api/photos/${file.id}`,
        createdAt: file.createdTime ?? null,
      },
    ]
  })
}

export async function uploadPhoto(file: {
  buffer: Buffer
  originalname: string
  mimetype: string
}) {
  if (!isAllowedImage(file.mimetype)) {
    throw new Error('Only image files can be uploaded')
  }

  const { drive, folderId } = getClient()
  const created = await drive.files.create({
    requestBody: {
      name: safeFileName(file.originalname, file.mimetype),
      parents: [folderId],
    },
    media: {
      mimeType: file.mimetype,
      body: Readable.from(file.buffer),
    },
    fields: 'id, name, createdTime',
    supportsAllDrives: true,
  })

  if (!created.data.id) throw new Error('Drive did not return a file id')

  return {
    id: created.data.id,
    name: created.data.name ?? 'photo',
    url: `/api/photos/${created.data.id}`,
    createdAt: created.data.createdTime ?? null,
  }
}

export async function getPhotoStream(id: string) {
  if (!isDriveId(id)) return null

  const { drive, folderId } = getClient()
  const meta = await drive.files.get({
    fileId: id,
    fields: 'id, mimeType, trashed, parents',
    supportsAllDrives: true,
  })

  if (
    meta.data.trashed ||
    !meta.data.parents?.includes(folderId) ||
    !meta.data.mimeType?.startsWith('image/')
  ) {
    return null
  }

  const media = await drive.files.get(
    { fileId: id, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' },
  )

  return {
    mimeType: meta.data.mimeType,
    stream: media.data as Readable,
  }
}
