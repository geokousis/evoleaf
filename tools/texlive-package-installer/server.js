#!/usr/bin/env node

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const crypto = require('crypto')

const toolkitRoot = path.resolve(__dirname, '..', '..')
const publicDir = path.join(__dirname, 'public')
const dockerComposeBin = path.join(toolkitRoot, 'bin', 'docker-compose')
const host = process.env.PACKAGE_INSTALLER_HOST || '127.0.0.1'
const port = Number(process.env.PACKAGE_INSTALLER_PORT || 4040)

const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/i
const jobs = new Map()
const watchers = new Map()

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function serveStatic(req, res) {
  let rel = req.url === '/' ? '/index.html' : req.url
  if (rel.includes('..')) {
    sendJson(res, 400, { error: 'invalid path' })
    return
  }
  const filePath = path.join(publicDir, rel)
  if (!filePath.startsWith(publicDir)) {
    sendJson(res, 400, { error: 'invalid path' })
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      sendJson(res, 500, { error: 'failed to read file' })
      return
    }

    const ext = path.extname(filePath)
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.js'
            ? 'application/javascript; charset=utf-8'
            : 'application/octet-stream'

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    })
    res.end(data)
  })
}

function parsePackageInput(raw) {
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '')
        .split(',')
        .map(v => v.trim())

  const dedup = []
  const seen = new Set()
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    dedup.push(value)
  }
  return dedup
}

function sanitizePackageName(name) {
  return PACKAGE_RE.test(name)
}

function getSnapshot(jobId) {
  const job = jobs.get(jobId)
  if (!job) return null
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: {
      total: job.packages.length,
      done: job.packages.filter(p =>
        ['installed', 'already_installed', 'not_found', 'failed', 'invalid_name'].includes(p.status)
      ).length,
    },
    packages: job.packages,
    logs: job.logs,
  }
}

function emit(jobId, type, payload) {
  const listeners = watchers.get(jobId)
  if (listeners) {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of listeners) {
      res.write(frame)
    }
  }
}

function updateJob(jobId, mutator, eventType) {
  const job = jobs.get(jobId)
  if (!job) return
  mutator(job)
  job.updatedAt = new Date().toISOString()
  const snapshot = getSnapshot(jobId)
  emit(jobId, eventType || 'update', snapshot)
}

function addLog(jobId, level, message) {
  updateJob(
    jobId,
    job => {
      job.logs.push({
        at: new Date().toISOString(),
        level,
        message,
      })
      if (job.logs.length > 500) {
        job.logs = job.logs.slice(-500)
      }
    },
    'log'
  )
}

function runDockerCompose(args, onLine) {
  return new Promise(resolve => {
    const child = spawn(dockerComposeBin, args, {
      cwd: toolkitRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let output = ''

    const lineBuffer = { stdout: '', stderr: '' }
    const handleChunk = (streamName, chunk) => {
      const text = chunk.toString('utf8')
      output += text
      lineBuffer[streamName] += text
      const parts = lineBuffer[streamName].split(/\r?\n/)
      lineBuffer[streamName] = parts.pop() || ''
      for (const line of parts) {
        onLine(line, streamName)
      }
    }

    child.stdout.on('data', chunk => handleChunk('stdout', chunk))
    child.stderr.on('data', chunk => handleChunk('stderr', chunk))

    child.on('close', code => {
      if (lineBuffer.stdout) onLine(lineBuffer.stdout, 'stdout')
      if (lineBuffer.stderr) onLine(lineBuffer.stderr, 'stderr')
      resolve({ code: code ?? 1, output })
    })
  })
}

function makePackageRecord(name) {
  return {
    name,
    status: 'queued',
    message: 'Queued',
    startedAt: null,
    finishedAt: null,
    logs: [],
  }
}

function setPackageState(jobId, packageName, state, message) {
  updateJob(
    jobId,
    job => {
      const pkg = job.packages.find(p => p.name === packageName)
      if (!pkg) return
      if (!pkg.startedAt && state !== 'queued') {
        pkg.startedAt = new Date().toISOString()
      }
      pkg.status = state
      pkg.message = message || pkg.message
      if (['installed', 'already_installed', 'not_found', 'failed', 'invalid_name'].includes(state)) {
        pkg.finishedAt = new Date().toISOString()
      }
    },
    'package'
  )
}

function appendPackageLog(jobId, packageName, line) {
  updateJob(
    jobId,
    job => {
      const pkg = job.packages.find(p => p.name === packageName)
      if (!pkg) return
      pkg.logs.push(line)
      if (pkg.logs.length > 200) {
        pkg.logs = pkg.logs.slice(-200)
      }
    },
    'package_log'
  )
}

function parseInstallResult(exitCode, output) {
  const text = output.toLowerCase()
  if (text.includes('cannot find package')) {
    return { status: 'not_found', message: 'Package does not exist in tlmgr repository' }
  }
  if (text.includes('already present') || text.includes('already installed')) {
    return { status: 'already_installed', message: 'Already installed' }
  }
  if (exitCode === 0) {
    return { status: 'installed', message: 'Installed successfully' }
  }
  return { status: 'failed', message: 'Installation failed; check package logs' }
}

async function processPackage(jobId, packageName) {
  if (!sanitizePackageName(packageName)) {
    setPackageState(jobId, packageName, 'invalid_name', 'Invalid package name')
    addLog(jobId, 'warn', `${packageName}: rejected invalid package name`)
    return
  }

  setPackageState(jobId, packageName, 'checking', 'Checking package metadata')
  addLog(jobId, 'info', `${packageName}: checking repository metadata`)

  const info = await runDockerCompose(
    ['exec', '-T', 'sharelatex', 'tlmgr', 'info', packageName],
    line => appendPackageLog(jobId, packageName, line)
  )

  const lowerInfo = info.output.toLowerCase()
  if (lowerInfo.includes('cannot find package')) {
    setPackageState(jobId, packageName, 'not_found', 'Package does not exist in repository')
    addLog(jobId, 'warn', `${packageName}: package not found`)
    return
  }

  if (lowerInfo.includes('installed: yes')) {
    setPackageState(jobId, packageName, 'already_installed', 'Already installed')
    addLog(jobId, 'info', `${packageName}: already installed`)
    return
  }

  setPackageState(jobId, packageName, 'installing', 'Installing package')
  addLog(jobId, 'info', `${packageName}: running tlmgr install`)

  const install = await runDockerCompose(
    ['exec', '-T', 'sharelatex', 'tlmgr', 'install', packageName],
    line => appendPackageLog(jobId, packageName, line)
  )

  const result = parseInstallResult(install.code, install.output)
  setPackageState(jobId, packageName, result.status, result.message)
  addLog(jobId, result.status === 'failed' ? 'error' : 'info', `${packageName}: ${result.message}`)
}

async function processJob(jobId) {
  updateJob(jobId, job => {
    job.status = 'running'
    job.startedAt = new Date().toISOString()
  }, 'job')

  const snapshot = getSnapshot(jobId)
  const installCandidates = snapshot.packages.map(p => p.name)

  for (const packageName of installCandidates) {
    await processPackage(jobId, packageName)
  }

  const final = getSnapshot(jobId)
  const hasInstallLike = final.packages.some(p => p.status === 'installed')

  if (hasInstallLike) {
    addLog(jobId, 'info', 'Refreshing TeX filename database (mktexlsr)')
    await runDockerCompose(
      ['exec', '-T', 'sharelatex', 'mktexlsr'],
      line => addLog(jobId, 'info', `mktexlsr: ${line}`)
    )
  }

  updateJob(jobId, job => {
    const failed = job.packages.some(p => p.status === 'failed')
    job.status = failed ? 'completed_with_errors' : 'completed'
    job.finishedAt = new Date().toISOString()
  }, 'job')
}

function createJob(rawPackages) {
  const id = crypto.randomUUID()
  const packages = parsePackageInput(rawPackages)
  const now = new Date().toISOString()

  const job = {
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    packages: packages.map(makePackageRecord),
    logs: [],
  }

  jobs.set(id, job)
  processJob(id).catch(err => {
    addLog(id, 'error', `Unhandled job error: ${err.message}`)
    updateJob(id, draft => {
      draft.status = 'failed'
      draft.finishedAt = new Date().toISOString()
    }, 'job')
  })

  return id
}

function handleEvents(req, res, jobId) {
  if (!jobs.has(jobId)) {
    sendJson(res, 404, { error: 'job not found' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })

  if (!watchers.has(jobId)) {
    watchers.set(jobId, new Set())
  }
  watchers.get(jobId).add(res)

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 15000)

  const initial = getSnapshot(jobId)
  res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`)

  req.on('close', () => {
    clearInterval(heartbeat)
    const set = watchers.get(jobId)
    if (set) {
      set.delete(res)
      if (set.size === 0) watchers.delete(jobId)
    }
  })
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'))
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/public/') || req.url.endsWith('.css') || req.url.endsWith('.js') || req.url.endsWith('.html'))) {
      if (req.url.startsWith('/public/')) {
        req.url = req.url.replace('/public', '')
      }
      serveStatic(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/api/jobs') {
      const raw = await collectRequestBody(req)
      let payload = {}
      try {
        payload = raw ? JSON.parse(raw) : {}
      } catch (_err) {
        sendJson(res, 400, { error: 'invalid JSON' })
        return
      }

      const packages = parsePackageInput(payload.packages)
      if (packages.length === 0) {
        sendJson(res, 400, { error: 'provide at least one package name' })
        return
      }

      const jobId = createJob(packages)
      sendJson(res, 201, { jobId })
      return
    }

    if (req.method === 'GET' && req.url.startsWith('/api/jobs/')) {
      const parts = req.url.split('/').filter(Boolean)
      const jobId = parts[2]
      const tail = parts[3] || ''

      if (!jobId) {
        sendJson(res, 400, { error: 'missing job id' })
        return
      }

      if (tail === 'events') {
        handleEvents(req, res, jobId)
        return
      }

      const snapshot = getSnapshot(jobId)
      if (!snapshot) {
        sendJson(res, 404, { error: 'job not found' })
        return
      }
      sendJson(res, 200, snapshot)
      return
    }

    sendJson(res, 404, { error: 'not found' })
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'internal server error' })
  }
})

server.listen(port, host, () => {
  process.stdout.write(`TeX package installer UI: http://${host}:${port}\n`)
})
