import dotenv from 'dotenv'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { google } from 'googleapis'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(scriptDir, '../.env') })

const PORT = 3333
const REDIRECT = `http://127.0.0.1:${PORT}/callback`
const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()

if (!clientId || !clientSecret) {
  console.error(
    'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in capture-api/.env first.',
  )
  process.exit(1)
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT)
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
})

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404)
      res.end()
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400)
      res.end('Missing code')
      return
    }
    const { tokens } = await oauth2.getToken(code)
    const envPath = path.resolve(scriptDir, '../.env')
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    const lines = existing
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('GOOGLE_CLIENT_ID=') &&
          !line.startsWith('GOOGLE_CLIENT_SECRET=') &&
          !line.startsWith('GOOGLE_REFRESH_TOKEN='),
      )
      .join('\n')
      .replace(/\n*$/, '\n')
    writeFileSync(
      envPath,
      `${lines}GOOGLE_CLIENT_ID=${clientId}\nGOOGLE_CLIENT_SECRET=${clientSecret}\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token ?? ''}\n`,
    )
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('You can close this tab and return to the terminal.')
    console.log(`Saved tokens to ${envPath}`)
    console.log(
      'Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN in Railway Variables. Do not commit .env.',
    )
    if (!tokens.refresh_token) {
      console.log(
        'No refresh token returned. Remove the app access at https://myaccount.google.com/permissions and run this again.',
      )
    }
    server.close()
  } catch (error) {
    console.error(error)
    res.writeHead(500)
    res.end('Auth failed')
    server.close()
    process.exit(1)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL, then sign in with the Google account that owns the album folder:\n')
  console.log(authUrl)
})
