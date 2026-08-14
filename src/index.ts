import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { DriveConfigError, getPhotoStream, listPhotos, publicDriveError, uploadPhoto } from './drive.ts'

const apiDir = path.resolve(import.meta.dirname, '..')
dotenv.config({ path: path.join(apiDir, '.env') })
dotenv.config({ path: path.resolve(apiDir, '../capture/.env') })

const PORT = Number(process.env.PORT || 3001)
const frontendOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://192.168.254.109:5173',
  'https://christian-and-franchess.vercel.app',
  ...(process.env.FRONTEND_ORIGIN ?? '').split(','),
]
  .map((origin) => origin.trim())
  .filter(Boolean)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 8 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
      return
    }
    cb(new Error('Only image files can be uploaded'))
  },
})

const app = express()
const allowedOrigins = new Set(frontendOrigins)

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true)
        return
      }
      try {
        const { hostname } = new URL(origin)
        if (
          hostname === 'christian-and-franchess.vercel.app' ||
          (hostname.endsWith('.vercel.app') &&
            hostname.includes('christian-and-franchess'))
        ) {
          callback(null, true)
          return
        }
      } catch {
        /* ignore invalid origins */
      }
      callback(null, false)
    },
  }),
)
app.use(express.json())

function sendDriveError(res: express.Response, error: unknown, fallback: string) {
  console.error(error)
  const message = publicDriveError(error)
  res.status(error instanceof DriveConfigError ? 503 : 500).json({
    error: message ?? fallback,
  })
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    drive: {
      folderId: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID?.trim()),
      serviceAccountJson: Boolean(
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(),
      ),
      credentialsFile: Boolean(
        process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim(),
      ),
    },
  })
})

app.get('/api/photos', async (_req, res) => {
  try {
    const photos = await listPhotos()
    res.json({ photos })
  } catch (error) {
    sendDriveError(res, error, 'Could not load photos')
  }
})

app.post('/api/photos', (req, res, next) => {
  upload.array('photos', 8)(req, res, (error) => {
    if (!error) {
      next()
      return
    }
    const message =
      error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
        ? 'Each photo must be under 25MB'
        : error instanceof Error
          ? error.message
          : 'Upload failed'
    res.status(400).json({ error: message })
  })
})

app.post('/api/photos', async (req, res) => {
  const files = req.files
  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: 'Choose at least one photo' })
    return
  }

  try {
    const photos = []
    for (const file of files) {
      photos.push(
        await uploadPhoto({
          buffer: file.buffer,
          originalname: file.originalname,
          mimetype: file.mimetype,
        }),
      )
    }
    res.status(201).json({ photos })
  } catch (error) {
    sendDriveError(res, error, 'Could not save photo to Drive')
  }
})

app.get('/api/photos/:id', async (req, res) => {
  try {
    const photo = await getPhotoStream(req.params.id)
    if (!photo) {
      res.status(404).json({ error: 'Photo not found' })
      return
    }
    res.setHeader('Content-Type', photo.mimeType)
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable')
    photo.stream.on('error', () => {
      if (!res.headersSent) res.status(500).end()
      else res.end()
    })
    photo.stream.pipe(res)
  } catch (error) {
    sendDriveError(res, error, 'Could not load photo')
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Album API listening on http://localhost:${PORT}`)
})
