import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(apiDir, '.env') })

const PORT = Number(process.env.PORT || 3001)

process.on('unhandledRejection', (error) => {
  console.error('unhandledRejection', error)
})
process.on('uncaughtException', (error) => {
  console.error('uncaughtException', error)
})

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
app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    maxAge: 86400,
  }),
)
app.use(express.json())

async function sendDriveError(res, error, fallback) {
  console.error(error)
  const { DriveConfigError, publicDriveError } = await import('./drive.js')
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
      oauth: Boolean(
        process.env.GOOGLE_REFRESH_TOKEN?.trim() &&
          process.env.GOOGLE_CLIENT_ID?.trim() &&
          process.env.GOOGLE_CLIENT_SECRET?.trim(),
      ),
      serviceAccountJson: Boolean(
        process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim(),
      ),
    },
  })
})

app.get('/api/photos', async (_req, res) => {
  try {
    const { listPhotos } = await import('./drive.js')
    res.json({ photos: await listPhotos() })
  } catch (error) {
    await sendDriveError(res, error, 'Could not load photos')
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
    const { uploadPhoto } = await import('./drive.js')
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
    await sendDriveError(res, error, 'Could not save photo to Drive')
  }
})

app.get('/api/photos/:id', async (req, res) => {
  try {
    const { getPhotoStream } = await import('./drive.js')
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
    await sendDriveError(res, error, 'Could not load photo')
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Album API listening on 0.0.0.0:${PORT}`)
})
