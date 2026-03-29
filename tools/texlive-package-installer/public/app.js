const installBtn = document.getElementById('install-btn')
const packagesInput = document.getElementById('packages')
const statusLine = document.getElementById('status-line')
const progressPanel = document.getElementById('progress-panel')
const logPanel = document.getElementById('log-panel')
const progressBar = document.getElementById('progress-bar')
const progressMeta = document.getElementById('progress-meta')
const jobState = document.getElementById('job-state')
const packageList = document.getElementById('package-list')
const logOutput = document.getElementById('log-output')

let activeStream = null

function setBusy(isBusy) {
  installBtn.disabled = isBusy
}

function appendLog(line) {
  if (!line) return
  logOutput.textContent += `${line}\n`
  logOutput.scrollTop = logOutput.scrollHeight
}

function statusClass(status) {
  if (!status) return ''
  return String(status).replace(/[^a-z0-9_]+/gi, '_')
}

function renderPackages(packages) {
  packageList.innerHTML = ''
  for (const pkg of packages || []) {
    const item = document.createElement('div')
    item.className = 'package-item'

    const row = document.createElement('div')
    row.className = 'package-row'

    const name = document.createElement('div')
    name.className = 'pkg-name'
    name.textContent = pkg.name

    const badge = document.createElement('span')
    badge.className = `badge ${statusClass(pkg.status)}`
    badge.textContent = pkg.status

    row.append(name, badge)

    const msg = document.createElement('div')
    msg.className = 'pkg-message'
    msg.textContent = pkg.message || ''

    item.append(row, msg)
    packageList.appendChild(item)
  }
}

function render(snapshot) {
  if (!snapshot) return
  progressPanel.hidden = false
  logPanel.hidden = false

  const total = snapshot.progress?.total || 0
  const done = snapshot.progress?.done || 0
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0
  progressBar.style.width = `${pct}%`
  progressMeta.textContent = `${done} / ${total} complete`

  jobState.textContent = snapshot.status
  jobState.className = `pill ${statusClass(snapshot.status)}`

  renderPackages(snapshot.packages)

  if (['completed', 'completed_with_errors', 'failed'].includes(snapshot.status)) {
    setBusy(false)
    statusLine.textContent = `Job ${snapshot.status.replace(/_/g, ' ')}`
    if (activeStream) {
      activeStream.close()
      activeStream = null
    }
  } else {
    statusLine.textContent = `Job ${snapshot.status}`
  }
}

function openJobStream(jobId) {
  if (activeStream) {
    activeStream.close()
    activeStream = null
  }

  const stream = new EventSource(`/api/jobs/${jobId}/events`)
  activeStream = stream

  stream.addEventListener('snapshot', event => {
    const snapshot = JSON.parse(event.data)
    render(snapshot)
    appendLog(`[snapshot] Job ${snapshot.id} loaded`)
  })

  stream.addEventListener('log', event => {
    const snapshot = JSON.parse(event.data)
    const latest = snapshot.logs?.[snapshot.logs.length - 1]
    if (latest) {
      appendLog(`[${latest.level}] ${latest.message}`)
    }
    render(snapshot)
  })

  stream.addEventListener('package', event => {
    const snapshot = JSON.parse(event.data)
    const pkg = snapshot.packages?.find(p => p.status !== 'queued')
    if (pkg) {
      appendLog(`[package] ${pkg.name}: ${pkg.status} - ${pkg.message}`)
    }
    render(snapshot)
  })

  stream.addEventListener('job', event => {
    const snapshot = JSON.parse(event.data)
    appendLog(`[job] ${snapshot.status}`)
    render(snapshot)
  })

  stream.onerror = () => {
    appendLog('[error] Event stream disconnected')
  }
}

installBtn.addEventListener('click', async () => {
  const value = packagesInput.value.trim()
  if (!value) {
    statusLine.textContent = 'Enter at least one package name'
    return
  }

  setBusy(true)
  statusLine.textContent = 'Creating install job...'
  logOutput.textContent = ''

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages: value }),
    })

    const payload = await response.json()
    if (!response.ok) {
      throw new Error(payload.error || 'Failed to create job')
    }

    appendLog(`[job] Created ${payload.jobId}`)
    openJobStream(payload.jobId)
  } catch (error) {
    setBusy(false)
    statusLine.textContent = error.message
    appendLog(`[error] ${error.message}`)
  }
})
