(function () {
  const apiBase = document.querySelector('meta[name="ol-installPackagesApiBase"]')?.content || '/install/api'

  const input = document.getElementById('install-packages-input')
  const submit = document.getElementById('install-packages-submit')
  const statusLine = document.getElementById('install-packages-status')
  const progressPanel = document.getElementById('install-progress-panel')
  const logPanel = document.getElementById('install-log-panel')
  const jobState = document.getElementById('install-job-state')
  const progressFill = document.getElementById('install-progress-fill')
  const progressMeta = document.getElementById('install-progress-meta')
  const packageList = document.getElementById('install-package-list')
  const logOutput = document.getElementById('install-log-output')

  const csrf = document.querySelector('meta[name="ol-csrfToken"]')?.content
  let activeStream = null

  function setBusy(flag) {
    submit.disabled = flag
  }

  function appendLog(line) {
    if (!line) return
    logOutput.textContent += `${line}\n`
    logOutput.scrollTop = logOutput.scrollHeight
  }

  function classSafe(value) {
    return String(value || '').replace(/[^a-z0-9_]+/gi, '_')
  }

  function renderPackages(packages) {
    packageList.innerHTML = ''
    ;(packages || []).forEach(pkg => {
      const item = document.createElement('div')
      item.className = 'install-item'

      const row = document.createElement('div')
      row.className = 'install-row'

      const name = document.createElement('div')
      name.className = 'install-name'
      name.textContent = pkg.name

      const badge = document.createElement('span')
      badge.className = `install-badge-status ${classSafe(pkg.status)}`
      badge.textContent = pkg.status

      row.append(name, badge)

      const msg = document.createElement('div')
      msg.className = 'install-msg'
      msg.textContent = pkg.message || ''

      item.append(row, msg)
      packageList.appendChild(item)
    })
  }

  function render(snapshot) {
    if (!snapshot) return

    progressPanel.hidden = false
    logPanel.hidden = false

    const total = snapshot.progress?.total || 0
    const done = snapshot.progress?.done || 0
    const percent = total > 0 ? Math.floor((done / total) * 100) : 0

    progressFill.style.width = `${percent}%`
    progressMeta.textContent = `${done} / ${total} complete`

    jobState.textContent = snapshot.status
    jobState.className = `install-pill ${classSafe(snapshot.status)}`

    renderPackages(snapshot.packages)

    if (['completed', 'completed_with_errors', 'failed'].includes(snapshot.status)) {
      setBusy(false)
      statusLine.textContent = snapshot.status.replace(/_/g, ' ')
      if (activeStream) {
        activeStream.close()
        activeStream = null
      }
    } else {
      statusLine.textContent = snapshot.status
    }
  }

  function openStream(jobId) {
    if (activeStream) {
      activeStream.close()
      activeStream = null
    }

    const source = new EventSource(`${apiBase}/jobs/${jobId}/events`)
    activeStream = source

    source.addEventListener('snapshot', event => {
      const snapshot = JSON.parse(event.data)
      render(snapshot)
      appendLog(`[snapshot] job ${snapshot.id} loaded`)
    })

    source.addEventListener('log', event => {
      const snapshot = JSON.parse(event.data)
      const latest = snapshot.logs?.[snapshot.logs.length - 1]
      if (latest) {
        appendLog(`[${latest.level}] ${latest.message}`)
      }
      render(snapshot)
    })

    source.addEventListener('package', event => {
      const snapshot = JSON.parse(event.data)
      render(snapshot)
    })

    source.addEventListener('job', event => {
      const snapshot = JSON.parse(event.data)
      appendLog(`[job] ${snapshot.status}`)
      render(snapshot)
    })

    source.onerror = function () {
      appendLog('[error] connection lost')
    }
  }

  submit.addEventListener('click', async function () {
    const packages = input.value.trim()
    if (!packages) {
      statusLine.textContent = 'Enter at least one package name'
      return
    }

    setBusy(true)
    statusLine.textContent = 'Creating job...'
    logOutput.textContent = ''

    try {
      const response = await fetch(`${apiBase}/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ packages }),
      })

      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to create install job')
      }

      appendLog(`[job] created ${payload.jobId}`)
      openStream(payload.jobId)
    } catch (error) {
      setBusy(false)
      statusLine.textContent = error.message
      appendLog(`[error] ${error.message}`)
    }
  })
})()
