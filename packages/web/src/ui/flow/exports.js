const most = require('most')

const { solidsAsBlob } = require('@jscad/io')
const { geometries, modifiers } = require('@jscad/modeling')

const { withLatestFrom } = require('../../most-utils')

const { exportFilePathFromFormatAndDesign } = require('../../core/io/exportUtils')

const generateId = (prefix) => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`
  }
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1)
  return `${prefix}-${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`
}

const solidToLayerlingShape = (solid, index, designName = 'JSCAD') => {
  const triSolid = modifiers.generalize({ snap: true, triangulate: true }, solid)
  const polygons = geometries.geom3.toPolygons(triSolid)

  // Convert from JSCAD (Z-up) to Layerling (Y-up): x -> x, z -> y, -y -> z
  const rawPositions = []
  for (const polygon of polygons) {
    for (const v of polygon.vertices) {
      rawPositions.push(v[0], v[2], -v[1])
    }
  }

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity

  for (let i = 0; i < rawPositions.length; i += 3) {
    const x = rawPositions[i]
    const y = rawPositions[i + 1]
    const z = rawPositions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }

  const width = Math.max(0.01, maxX - minX)
  const height = Math.max(0.01, maxY - minY)
  const depth = Math.max(0.01, maxZ - minZ)
  const size = Math.max(width, depth)

  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  const elevation = minY

  // Local positions: centered on X and Z, sitting on the workplane at Y = 0
  const localPositions = new Array(rawPositions.length)
  for (let i = 0; i < rawPositions.length; i += 3) {
    localPositions[i] = Number((rawPositions[i] - centerX).toFixed(5))
    localPositions[i + 1] = Number((rawPositions[i + 1] - elevation).toFixed(5))
    localPositions[i + 2] = Number((rawPositions[i + 2] - centerZ).toFixed(5))
  }

  let color = '#0098c7'
  if (solid.color && Array.isArray(solid.color)) {
    const [r, g, b] = solid.color.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0'))
    color = `#${r}${g}${b}`
  }

  return {
    id: generateId('uploaded-mesh'),
    name: designName + (index > 0 ? ` ${index + 1}` : ''),
    kind: 'mesh',
    color,
    x: Number(centerX.toFixed(2)),
    z: Number(centerZ.toFixed(2)),
    size: Number(size.toFixed(2)),
    width: Number(width.toFixed(2)),
    depth: Number(depth.toFixed(2)),
    height: Number(height.toFixed(2)),
    rotation: 0,
    rotationX: 0,
    rotationZ: 0,
    importedMesh: {
      positions: localPositions,
      baseWidth: Number(width.toFixed(2)),
      baseDepth: Number(depth.toFixed(2)),
      baseHeight: Number(height.toFixed(2)),
      triangleCount: localPositions.length / 9,
      sourceFormat: 'stl',
      assetId: generateId('asset').replace(/-/g, '')
    },
    locked: false,
    hidden: false
  }
}

const solidsToLayerlingClipboard = (solids, designName) => {
  const solids3d = solids.filter((s) => geometries.geom3.isA(s))
  if (solids3d.length === 0) throw new Error('No 3D solids to export')
  const shapes = solids3d.map((s, i) => solidToLayerlingShape(s, i, designName))
  const payload = {
    copiedAt: Date.now(),
    shapes
  }
  return `LAYERLING/1\n${JSON.stringify(payload, null, 4)}`
}

const copyTextToClipboard = (text) => {
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(text)
  }

  return new Promise((resolve, reject) => {
    try {
      if (typeof document === 'undefined') {
        return reject(new Error('Document not available'))
      }
      const textArea = document.createElement('textarea')
      textArea.value = text
      textArea.style.position = 'fixed'
      textArea.style.top = '0'
      textArea.style.left = '0'
      textArea.style.opacity = '0'
      textArea.style.pointerEvents = 'none'
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      const successful = document.execCommand('copy')
      document.body.removeChild(textArea)
      if (successful) {
        resolve()
      } else {
        reject(new Error('execCommand copy returned false'))
      }
    } catch (err) {
      reject(err)
    }
  })
}

const reducers = {
  initialize: (state) => {
    const io = {
      exportFormat: '',
      exportFilePath: '', // default export file path
      availableExportFormats: []
    }
    return { io }
  },

  setExportFormat: (state, exportFormat) => {
    const io = Object.assign({ }, state.io, exportFilePathFromFormatAndDesign(state.design, exportFormat), { exportFormat })
    return { io }
  },

  requestExport: (state) => {
    const { exportFilePath, exportFormat } = state.io
    const { solids } = state.design
    const { saveAs } = require('file-saver')
    const format = exportFormat
    const blob = solidsAsBlob(solids, { format })
    // FIXME: BAD ! does not use side effects!
    // fs.writeFileSync(filePath, buffer)
    saveAs(blob, exportFilePath)
    // return { io }
  },

  copyForLayerling: (state) => {
    const { solids } = state.design
    if (!solids || solids.length === 0) {
      console.warn('No solids to copy')
      return
    }
    let layerlingClipboardText
    try {
      const designName = state.design && state.design.name ? state.design.name : 'JSCAD'
      layerlingClipboardText = solidsToLayerlingClipboard(solids, designName)
    } catch (e) {
      console.error('Failed to serialize solids for Layerling:', e)
      return
    }

    if (layerlingClipboardText) {
      copyTextToClipboard(layerlingClipboardText).then(() => {
        console.log('Model copied to clipboard in Layerling format (LAYERLING/1)')
        const btn = typeof document !== 'undefined' && document.getElementById('copyLayerlingBtn')
        if (btn) {
          const originalValue = btn.value
          btn.value = 'Copied!'
          setTimeout(() => {
            btn.value = originalValue
          }, 1500)
        }
      }).catch((err) => {
        console.error('Clipboard write failed:', err)
        const w = window.open('', '_blank')
        if (w) {
          w.document.write('<pre>' + layerlingClipboardText.replace(/</g, '&lt;') + '</pre>')
          w.document.title = 'Layerling Clipboard — Copy this text'
        }
      })
    }
  }
}

const actions = ({ sources }) => {
  const initializeExports$ = most.just({})
    .thru(withLatestFrom(reducers.initialize, sources.state))
    .map((payload) => Object.assign({}, { type: 'initializeExports', sink: 'state' }, { state: payload }))

  const changeExportFormat$ = sources.dom.select('#exportFormats').events('change')
    .map((e) => e.target.value)
    .thru(withLatestFrom(reducers.setExportFormat, sources.state))
    .map((payload) => Object.assign({}, { type: 'changeExportFormat', sink: 'state' }, { state: payload }))
    .multicast()

  const requestExport$ = sources.dom.select('#exportBtn').events('click')
    .thru(withLatestFrom(reducers.requestExport, sources.state))
    .map((data) => ({ type: 'exportRequested', data }))

  const copyLayerling$ = sources.dom.select('#copyLayerlingBtn').events('click')
    .thru(withLatestFrom(reducers.copyForLayerling, sources.state))
    .map((data) => ({ type: 'copyLayerlingRequested', data }))

  return { initializeExports$, requestExport$, changeExportFormat$, copyLayerling$ }
}

module.exports = actions
