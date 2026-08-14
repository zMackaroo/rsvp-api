import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'

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

let client = null

function apiRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

function parseFolderId(value) {
  const trimmed = value.trim()
  const fromUrl = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/)
  return fromUrl?.[1] ?? trimmed
}

function resolveKeyFile(keyFile) {
  if (path.isAbsolute(keyFile)) return keyFile
  const candidates = [
    path.join(apiRoot(), keyFile),
    path.join(apiRoot(), '../capture', keyFile),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function parseServiceAccount(raw, source) {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.private_key === 'string') {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
    }
    if (!parsed.client_email || !parsed.private_key) {
      throw new DriveConfigError(
        `${source} must include client_email and private_key`,
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof DriveConfigError) throw error
    throw new DriveConfigError(`${source} is not valid JSON`)
  }
}

function loadCredentials() {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()
  if (inline) return parseServiceAccount(inline, 'GOOGLE_SERVICE_ACCOUNT_JSON')

  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  if (!keyFile) return null

  const resolved = resolveKeyFile(keyFile)
  if (!existsSync(resolved)) {
    throw new DriveConfigError(
      'Service account key file was not found. On Railway, set GOOGLE_SERVICE_ACCOUNT_JSON to the JSON key contents.',
    )
  }

  return parseServiceAccount(
    readFileSync(resolved, 'utf8'),
    'GOOGLE_APPLICATION_CREDENTIALS',
  )
}

function getAuth() {
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN?.trim()
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()

  if (refreshToken && clientId && clientSecret) {
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret)
    oauth2.setCredentials({ refresh_token: refreshToken })
    return oauth2
  }

  const credentials = loadCredentials()
  if (!credentials) {
    throw new DriveConfigError(
      'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN, or GOOGLE_SERVICE_ACCOUNT_JSON.',
    )
  }

  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  })
}

function getClient() {
  if (client) return client

  const folderRaw = process.env.GOOGLE_DRIVE_FOLDER_ID
  if (!folderRaw?.trim()) {
    throw new DriveConfigError('GOOGLE_DRIVE_FOLDER_ID is not set')
  }

  client = {
    drive: google.drive({ version: 'v3', auth: getAuth() }),
    folderId: parseFolderId(folderRaw),
  }
  return client
}

export function publicDriveError(error) {
  if (error instanceof DriveConfigError) return error.message

  const googleMessage = error?.response?.data?.error?.message
  if (typeof googleMessage !== 'string') return null

  const lower = googleMessage.toLowerCase()
  if (lower.includes('file not found')) {
    return 'Drive folder was not found. Check GOOGLE_DRIVE_FOLDER_ID.'
  }
  if (lower.includes('insufficient') || lower.includes('permission')) {
    return 'That Google account cannot write to the Drive folder.'
  }
  if (lower.includes('quota') || lower.includes('storage')) {
    return 'A service account cannot store files in a personal Google Drive. Use GOOGLE_REFRESH_TOKEN from your own Google account.'
  }
  return googleMessage
}

function escapeQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function isDriveId(id) {
  return /^[a-zA-Z0-9_-]{10,}$/.test(id)
}

function safeFileName(originalName, mimeType) {
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

export function isAllowedImage(mimeType) {
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

export async function uploadPhoto(file) {
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

export async function getPhotoStream(id) {
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
    stream: media.data,
  }
}
