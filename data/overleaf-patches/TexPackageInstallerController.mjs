import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import logger from '@overleaf/logger'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]*$/i
const FINISHED_STATES = new Set([
  'installed',
  'already_installed',
  'not_found',
  'failed',
  'invalid_name',
])

const jobs = new Map()
const watchers = new Map()
const pendingJobIds = []
let queueWorkerRunning = false
const SUCCESS_STATES = new Set(['installed', 'already_installed'])
const SAVED_PACKAGES_FILE =
  process.env.TEX_PACKAGE_STATE_FILE ||
  '/var/lib/overleaf/system/tex-packages-installed.txt'
const SAVED_PACKAGES_AUDIT_FILE =
  process.env.TEX_PACKAGE_AUDIT_FILE ||
  '/var/lib/overleaf/system/tex-packages-install-audit.log'
const TEXLIVE_YEAR = process.env.OVERLEAF_TEXLIVE_YEAR || '2025'
const TLMGR_REPOSITORY =
  process.env.OVERLEAF_TLMGR_REPOSITORY ||
  `https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/${TEXLIVE_YEAR}/tlnet-final`
function parsePackageInput(input) {
  const values = String(input || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)

  const dedup = []
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    dedup.push(value)
  }

  return dedup
}

function buildJobSnapshot(job) {
  const done = job.packages.filter(pkg => FINISHED_STATES.has(pkg.status)).length
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: {
      total: job.packages.length,
      done,
    },
    packages: job.packages,
    logs: job.logs,
  }
}

function emit(jobId, eventName) {
  const job = jobs.get(jobId)
  if (!job) return

  const clients = watchers.get(jobId)
  if (!clients || clients.size === 0) return

  const payload = JSON.stringify(buildJobSnapshot(job))
  const frame = `event: ${eventName}\ndata: ${payload}\n\n`
  for (const res of clients) {
    res.write(frame)
  }
}

function updateJob(jobId, updateFn, eventName = 'update') {
  const job = jobs.get(jobId)
  if (!job) return
  updateFn(job)
  job.updatedAt = new Date().toISOString()
  emit(jobId, eventName)
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

function setPackageStatus(jobId, packageName, status, message) {
  updateJob(
    jobId,
    job => {
      const pkg = job.packages.find(p => p.name === packageName)
      if (!pkg) return

      if (pkg.startedAt == null && status !== 'queued') {
        pkg.startedAt = new Date().toISOString()
      }

      pkg.status = status
      if (message) pkg.message = message

      if (FINISHED_STATES.has(status)) {
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

async function persistSuccessfulPackage(jobId, requestedName, installTarget) {
  const normalized = String(installTarget || requestedName || '')
    .trim()
    .toLowerCase()
  if (!normalized || !PACKAGE_RE.test(normalized)) return

  try {
    await fsp.mkdir(path.dirname(SAVED_PACKAGES_FILE), { recursive: true })

    let existing = ''
    try {
      existing = await fsp.readFile(SAVED_PACKAGES_FILE, 'utf8')
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err
    }

    const set = new Set(
      existing
        .split(/\r?\n/)
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
    )

    if (!set.has(normalized)) {
      set.add(normalized)
      const sorted = Array.from(set).sort()
      await fsp.writeFile(SAVED_PACKAGES_FILE, `${sorted.join('\n')}\n`, 'utf8')
      addLog(
        jobId,
        'info',
        `${requestedName}: saved to persistent package list (${normalized})`
      )
    }

    const auditLine = `${new Date().toISOString()}\t${requestedName}\t${normalized}\n`
    await fsp.appendFile(SAVED_PACKAGES_AUDIT_FILE, auditLine, 'utf8')
  } catch (err) {
    logger.error(
      { err, requestedName, installTarget, savedPackagesFile: SAVED_PACKAGES_FILE },
      'failed to persist tex package install state'
    )
    addLog(jobId, 'warn', `${requestedName}: failed to save package to state file`)
  }
}

function runCmd(args, onLine, options = {}) {
  if (args[0] === 'tlmgr' && !args.includes('--repository')) {
    args = ['tlmgr', '--repository', TLMGR_REPOSITORY, ...args.slice(1)]
  }

  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : null

  return new Promise(resolve => {
    const proc = spawn(args[0], args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let output = ''
    const buffers = { stdout: '', stderr: '' }
    let timedOut = false
    let settled = false
    let timeoutHandle = null
    let killHandle = null

    function onChunk(kind, chunk) {
      const text = chunk.toString('utf8')
      output += text
      buffers[kind] += text
      const lines = buffers[kind].split(/\r?\n/)
      buffers[kind] = lines.pop() || ''
      for (const line of lines) {
        onLine(line, kind)
      }
    }

    proc.stdout.on('data', chunk => onChunk('stdout', chunk))
    proc.stderr.on('data', chunk => onChunk('stderr', chunk))

    if (timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true
        onLine(`command timed out after ${timeoutMs}ms`, 'stderr')
        proc.kill('SIGTERM')
        killHandle = setTimeout(() => {
          proc.kill('SIGKILL')
        }, 2000)
      }, timeoutMs)
    }

    proc.on('close', code => {
      if (settled) return
      settled = true
      if (timeoutHandle) clearTimeout(timeoutHandle)
      if (killHandle) clearTimeout(killHandle)
      if (buffers.stdout) onLine(buffers.stdout, 'stdout')
      if (buffers.stderr) onLine(buffers.stderr, 'stderr')
      resolve({ code: code ?? 1, output, timedOut })
    })
  })
}

function parseInstallOutcome(code, output) {
  const text = output.toLowerCase()

  if (text.includes('cannot find package')) {
    return {
      status: 'not_found',
      message: 'Package does not exist in TeX Live repository',
    }
  }
  if (text.includes('already present') || text.includes('already installed')) {
    return { status: 'already_installed', message: 'Already installed' }
  }
  if (code === 0) {
    return { status: 'installed', message: 'Installed successfully' }
  }
  const lines = output
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
  const reasonLine =
    lines
      .slice()
      .reverse()
      .find(
        line =>
          /error|failed|cannot|could not|timeout|timed out|permission/i.test(
            line
          )
      ) || lines[lines.length - 1]
  return {
    status: 'failed',
    message: reasonLine
      ? `Installation failed: ${reasonLine}`
      : 'Installation failed',
  }
}

function parseTlmgrOwners(output) {
  const owners = []
  const seen = new Set()
  const lines = output.split(/\r?\n/)
  for (const line of lines) {
    const match = line.match(/^([a-z0-9][a-z0-9._-]*):\s*$/i)
    if (!match) continue
    const pkg = match[1]
    if (seen.has(pkg)) continue
    seen.add(pkg)
    owners.push(pkg)
  }
  return owners
}

async function resolvePackageFromFileName(jobId, packageName) {
  const search = await runCmd(
    ['tlmgr', 'search', '--global', '--file', `/${packageName}.sty`],
    line => appendPackageLog(jobId, packageName, line)
  )
  const owners = parseTlmgrOwners(search.output)
  return owners
}

function chooseBestOwner(packageName, owners) {
  if (owners.length <= 1) return owners[0]

  const exact = owners.find(o => o.toLowerCase() === packageName.toLowerCase())
  if (exact) return exact

  const nonDev = owners.filter(
    o => !/dev|devel|development/i.test(o) && !/-dev$/i.test(o)
  )
  if (nonDev.length === 1) return nonDev[0]

  return null
}

async function probeExistingFiles(packageName) {
  const probes = [`${packageName}.sty`, `${packageName}.cls`]
  for (const probe of probes) {
    const exists = await runCmd(['kpsewhich', probe], () => {})
    if (exists.output.trim()) {
      return probe
    }
  }
  return null
}

async function processPackage(jobId, packageName) {
  if (!PACKAGE_RE.test(packageName)) {
    setPackageStatus(jobId, packageName, 'invalid_name', 'Invalid package name')
    addLog(jobId, 'warn', `${packageName}: invalid package name`)
    return
  }

  const existingProbe = await probeExistingFiles(packageName)
  if (existingProbe) {
    setPackageStatus(
      jobId,
      packageName,
      'already_installed',
      `Already available (${existingProbe} found by kpsewhich)`
    )
    addLog(jobId, 'info', `${packageName}: already available on system`)
    return
  }

  setPackageStatus(jobId, packageName, 'checking', 'Checking package metadata')
  addLog(jobId, 'info', `${packageName}: checking metadata`)

  let installTarget = packageName
  let info = await runCmd(['tlmgr', 'info', installTarget], line => {
    appendPackageLog(jobId, packageName, line)
  })

  if (info.output.toLowerCase().includes('cannot find package')) {
    const owners = await resolvePackageFromFileName(jobId, packageName)
    const bestOwner = chooseBestOwner(packageName, owners)
    if (bestOwner) {
      installTarget = bestOwner
      addLog(
        jobId,
        'info',
        `${packageName}: mapped to TeX Live package ${installTarget}`
      )
      info = await runCmd(['tlmgr', 'info', installTarget], line => {
        appendPackageLog(jobId, packageName, line)
      })
    } else if (owners.length > 1) {
      setPackageStatus(
        jobId,
        packageName,
        'not_found',
        `Not a package name. Candidates: ${owners.join(', ')}`
      )
      addLog(
        jobId,
        'warn',
        `${packageName}: ambiguous package name, candidates ${owners.join(', ')}`
      )
      return
    } else {
      setPackageStatus(jobId, packageName, 'not_found', 'Package does not exist')
      addLog(jobId, 'warn', `${packageName}: package not found`)
      return
    }
  }

  if (info.output.toLowerCase().includes('installed: yes')) {
    const msg =
      installTarget === packageName
        ? 'Already installed'
        : `Already installed (provided by ${installTarget})`
    setPackageStatus(jobId, packageName, 'already_installed', msg)
    addLog(jobId, 'info', `${packageName}: already installed`)
    return
  }

  setPackageStatus(jobId, packageName, 'installing', 'Installing package')
  addLog(
    jobId,
    'info',
    `${packageName}: running tlmgr install ${installTarget}`
  )

  let installed = await runCmd(['tlmgr', 'install', installTarget], line => {
    appendPackageLog(jobId, packageName, line)
  })

  // Retry once for transient tlmgr issues (lock/network mirror hiccups).
  if (installed.code !== 0) {
    const lower = installed.output.toLowerCase()
    const transient =
      lower.includes('lock') ||
      lower.includes('timed out') ||
      lower.includes('timeout') ||
      lower.includes('could not') ||
      lower.includes('repository')
    if (transient) {
      addLog(
        jobId,
        'warn',
        `${packageName}: transient tlmgr error detected, retrying once`
      )
      installed = await runCmd(['tlmgr', 'install', installTarget], line => {
        appendPackageLog(jobId, packageName, line)
      })
    }
  }

  let result = parseInstallOutcome(installed.code, installed.output)
  if (result.status === 'failed') {
    // If install failed but package is now reported as installed, treat as success.
    const postInfo = await runCmd(['tlmgr', 'info', installTarget], line => {
      appendPackageLog(jobId, packageName, line)
    })
    if (postInfo.output.toLowerCase().includes('installed: yes')) {
      result = {
        status: 'already_installed',
        message: `Already installed (confirmed after retry via ${installTarget})`,
      }
    }
  }

  if (result.status === 'failed') {
    const probes = [`${packageName}.sty`, `${packageName}.cls`]
    if (installTarget !== packageName) {
      probes.push(`${installTarget}.sty`, `${installTarget}.cls`)
    }
    for (const probe of probes) {
      const exists = await runCmd(['kpsewhich', probe], () => {})
      if (exists.output.trim()) {
        result = {
          status: 'already_installed',
          message: `Already available (${probe} found by kpsewhich)`,
        }
        break
      }
    }
  }

  if (result.status === 'installed' && installTarget !== packageName) {
    result.message = `Installed successfully via ${installTarget}`
  }
  if (SUCCESS_STATES.has(result.status)) {
    await persistSuccessfulPackage(jobId, packageName, installTarget)
  }
  setPackageStatus(jobId, packageName, result.status, result.message)
  addLog(
    jobId,
    result.status === 'failed' ? 'error' : 'info',
    `${packageName}: ${result.message}`
  )
}

async function processJob(jobId) {
  updateJob(
    jobId,
    job => {
      job.status = 'running'
      job.startedAt = new Date().toISOString()
    },
    'job'
  )

  const job = jobs.get(jobId)
  if (!job) return

  for (const pkg of job.packages) {
    await processPackage(jobId, pkg.name)
  }

  const refreshed = jobs.get(jobId)
  const hasNewInstall = refreshed?.packages.some(p => p.status === 'installed')
  if (hasNewInstall) {
    addLog(
      jobId,
      'info',
      'Refreshing TeX filename database (mktexlsr texmf-dist)'
    )
    const mktex = await runCmd(
      ['mktexlsr', '/usr/local/texlive/2025/texmf-dist'],
      line => {
        addLog(jobId, 'info', `mktexlsr: ${line}`)
      },
      { timeoutMs: 20000 }
    )
    if (mktex.timedOut) {
      addLog(jobId, 'warn', 'mktexlsr timed out; continuing without blocking')
    } else if (mktex.code !== 0) {
      addLog(jobId, 'warn', 'mktexlsr exited with errors; continuing')
    } else {
      addLog(jobId, 'info', 'mktexlsr completed')
    }
  }

  addLog(jobId, 'info', 'Finalizing job results')

  updateJob(
    jobId,
    draft => {
      const hasErrors = draft.packages.some(p => p.status === 'failed')
      draft.status = hasErrors ? 'completed_with_errors' : 'completed'
      draft.finishedAt = new Date().toISOString()
    },
    'job'
  )
}

async function drainJobQueue() {
  if (queueWorkerRunning) return
  queueWorkerRunning = true

  try {
    while (pendingJobIds.length > 0) {
      const nextJobId = pendingJobIds.shift()
      if (!nextJobId) continue

      const job = jobs.get(nextJobId)
      if (!job || job.status !== 'queued') continue

      try {
        await processJob(nextJobId)
      } catch (err) {
        logger.error({ err, jobId: nextJobId }, 'package install job failed')
        addLog(nextJobId, 'error', `Unhandled job error: ${err.message}`)
        updateJob(
          nextJobId,
          draft => {
            draft.status = 'failed'
            draft.finishedAt = new Date().toISOString()
          },
          'job'
        )
      }
    }
  } finally {
    queueWorkerRunning = false
    if (pendingJobIds.length > 0) {
      void drainJobQueue()
    }
  }
}

function enqueueJob(jobId) {
  pendingJobIds.push(jobId)
  const queuedAhead = pendingJobIds.length - 1
  if (queuedAhead > 0) {
    addLog(
      jobId,
      'info',
      `Waiting for ${queuedAhead} install job${queuedAhead === 1 ? '' : 's'} ahead in queue`
    )
  }
  void drainJobQueue()
}

function buildPackageRecord(name) {
  return {
    name,
    status: 'queued',
    message: 'Queued',
    startedAt: null,
    finishedAt: null,
    logs: [],
  }
}

function createJob(packageNames) {
  const id = randomUUID()
  const now = new Date().toISOString()
  const job = {
    id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    packages: packageNames.map(buildPackageRecord),
    logs: [],
  }

  jobs.set(id, job)
  emit(id, 'snapshot')
  enqueueJob(id)

  return id
}

function renderInstallPage(req, res) {
  res.render('project/install-react', {
    title: 'install',
    projectDashboardReact: true,
  })
}

function createInstallJob(req, res) {
  const packageNames = parsePackageInput(req.body?.packages)

  if (packageNames.length === 0) {
    return res.status(400).json({ error: 'Provide at least one package name' })
  }

  const jobId = createJob(packageNames)
  res.status(201).json({ jobId })
}

function getInstallJob(req, res) {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'job not found' })
  }

  res.json(buildJobSnapshot(job))
}

function streamInstallJobEvents(req, res) {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    return res.status(404).json({ error: 'job not found' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })

  const id = req.params.jobId
  if (!watchers.has(id)) {
    watchers.set(id, new Set())
  }
  watchers.get(id).add(res)

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n')
  }, 15000)

  res.write(`event: snapshot\ndata: ${JSON.stringify(buildJobSnapshot(job))}\n\n`)

  req.on('close', () => {
    clearInterval(heartbeat)
    const bucket = watchers.get(id)
    if (bucket) {
      bucket.delete(res)
      if (bucket.size === 0) watchers.delete(id)
    }
  })
}

export default {
  renderInstallPage,
  createInstallJob,
  getInstallJob,
  streamInstallJobEvents,
}
