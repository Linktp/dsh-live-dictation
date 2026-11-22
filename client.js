/**
 * Push-to-talk: hold Alt to dictate, with the transcript refining in the composer while
 * you speak. A headless indicator occupies `conversation.input.right` and owns the
 * composer `inputActions` for the active Session.
 */
window.__ModuleLoader__.load({
  id: 'dsh-live-dictation',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const RATE = 16000
    const TICK_MS = 300
    const MIN_WINDOW_MS = 350
    const MAX_WINDOW_MS = 60000
    // New audio required before the whole utterance is transcribed again.
    const GROWTH_MS = 1200

    const MODIFIERS = new Set(['Alt', 'AltGraph', 'Control', 'Shift', 'Meta', 'CapsLock', 'OS'])

    const NS = 'push-to-talk'

    /** Bilingual copy without depending on a locale service API. */
    const copy = (() => {
      const language = ((document.documentElement.lang || '') || (navigator.language || 'en')).toLowerCase()
      const zh = language.indexOf('zh') === 0
      return zh ? {
        starting: '正在打开麦克风…',
        recording: '按住 Alt 说话',
        transcribing: '正在转写…',
        preparing: '正在准备语音模型，完成后即可继续',
        denied: '麦克风被拒绝：请在系统设置中允许本应用使用麦克风',
        unavailable: '无法访问麦克风',
        noService: '语音服务不可用：请先在插件设置中启用语音输入',
        failed: '转写失败',
        altKey: 'Alt',
        hint: '按住 Alt 或按住麦克风说话',
        notReady: '输入框还没准备好：点一下输入框再试',
        busy: '输入框正忙，稍后再试',
      } : {
        starting: 'Opening microphone…',
        recording: 'Listening… (release Alt to finish)',
        transcribing: 'Transcribing…',
        preparing: 'Preparing the speech model; keep holding or retry shortly',
        denied: 'Microphone denied: allow this app to record audio in system settings',
        unavailable: 'Microphone unavailable',
        noService: 'Speech service unavailable: enable voice input in plugin settings',
        failed: 'Transcription failed',
        altKey: 'Alt',
        hint: 'Hold Alt or hold the microphone to dictate',
        notReady: 'The composer is not ready: click into it and try again',
        busy: 'The composer is busy; try again in a moment',
      }
    })()

    let ctxRef = null
    let speechRef = null
    let speechDiag = ''
    let actions = null
    let locked = false
    let run = null
    let generation = 0
    let altHeld = false
    let pointerHeld = false

    // ------------------------------------------------------------------ store

    const store = (() => {
      let snapshot = { phase: 'idle', text: '', error: '', partial: '', elapsedMs: 0, seen: '' }
      const listeners = new Set()
      return {
        get: () => snapshot,
        set(patch) {
          snapshot = { ...snapshot, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    })()

    // ------------------------------------------------------------- utilities

    function speech() {
      if (speechRef) return speechRef
      if (!ctxRef) { speechDiag = 'no ctx'; return undefined }
      const notes = []
      let remote
      try {
        remote = ctxRef.remote
      } catch (_error) {
        remote = undefined
        notes.push('remote=gated')
      }
      if (!remote && ctxRef.get) {
        try {
          remote = ctxRef.get('remote')
          notes.push('remote=get')
        } catch (error) {
          notes.push('remote get failed: ' + failureText(error, '?'))
        }
      }
      // The Host Remote namespace is gated: reading `.speech` throws unless the caller
      // injected `remote.speech`, so this stays inside try/catch.
      try {
        if (remote && remote.speech) return remote.speech
      } catch (error) {
        notes.push('speech=gated')
      }
      try {
        if (ctxRef.get) {
          const direct = ctxRef.get('remote.speech')
          if (direct) return direct
          notes.push('get(remote.speech)=empty')
        }
      } catch (error) {
        notes.push('get(remote.speech) failed: ' + failureText(error, '?'))
      }
      notes.push('inject=' + (typeof ctxRef.inject === 'function' ? 'available' : 'missing'))
      speechDiag = notes.join('; ')
      return undefined
    }

    function failureText(error, fallback) {
      if (!error) return fallback || copy.failed
      if (typeof error === 'string') return error
      if (error.message) return error.message
      return fallback || copy.failed
    }

    /** Encode mono 16 kHz samples as the canonical PCM16 WAV the Host validates. */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i) }
      text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let i = 0; i < samples.length; i++) {
        const value = Math.max(-1, Math.min(1, samples[i]))
        view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    function audioBase64(bytes) {
      let text = ''
      for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
      return btoa(text)
    }

    function join(a, b) {
      const out = new Float32Array(a.length + b.length)
      out.set(a, 0)
      out.set(b, a.length)
      return out
    }

    /** Streaming box-filter resampler from the device rate to 16 kHz. */
    class Resampler {
      constructor(inputRate) {
        this.ratio = inputRate / RATE
        this.carry = new Float32Array(0)
        this.position = 0
      }

      push(input) {
        const data = this.carry.length === 0 ? input.slice() : join(this.carry, input)
        const ratio = this.ratio
        let position = this.position
        const output = new Float32Array(Math.max(0, Math.floor((data.length - position) / ratio)))
        let written = 0
        while (position + ratio <= data.length) {
          const from = position
          const to = position + ratio
          let sum = 0
          let weight = 0
          for (let i = Math.floor(from); i < Math.ceil(to); i++) {
            const overlap = Math.min(i + 1, to) - Math.max(i, from)
            if (overlap > 0) { sum += data[i] * overlap; weight += overlap }
          }
          output[written++] = weight > 0 ? sum / weight : 0
          position = to
        }
        const consumed = Math.floor(position)
        this.position = position - consumed
        this.carry = data.length > consumed ? data.slice(consumed) : new Float32Array(0)
        return written === output.length ? output : output.subarray(0, written)
      }
    }

    // ------------------------------------------------------- audio buffer ops

    function append(current, samples) {
      if (samples.length === 0) return
      current.chunks.push(new Float32Array(samples))
      current.total += samples.length
    }

    /** Copy the absolute sample range [start, end) out of the retained chunks. */
    function slice(current, start, end) {
      const length = Math.max(0, end - start)
      const out = new Float32Array(length)
      let written = 0
      let offset = current.base
      for (const chunk of current.chunks) {
        const chunkEnd = offset + chunk.length
        if (chunkEnd > start && offset < end) {
          const from = Math.max(start, offset) - offset
          const to = Math.min(end, chunkEnd) - offset
          out.set(chunk.subarray(from, to), written)
          written += to - from
        }
        offset = chunkEnd
        if (offset >= end) break
      }
      return out
    }

    // ------------------------------------------------------------- transcriber

    async function catalogOf(remote) {
      const result = await remote.catalog()
      if (!result || !result.ok) throw new Error(failureText(result && result.error, copy.failed))
      return result.value
    }

    async function transcribeSamples(current, remote, samples) {
      const wave = encodeWave(samples)
      if (current.catalog.maxAudioBytes && wave.byteLength > current.catalog.maxAudioBytes) {
        throw new Error(copy.failed)
      }
      const selection = current.catalog.selection || {}
      const request = { audioBase64: audioBase64(wave), providerId: selection.providerId, language: selection.language }
      const result = await remote.transcribe(request, current.abort.signal)
      if (!result || !result.ok) throw new Error(failureText(result && result.error, copy.failed))
      return String(result.value.text || '').replace(/\s+/g, ' ').trim()
    }

    function transcribeRange(current, remote, start, end) {
      return transcribeSamples(current, remote, slice(current, start, end))
    }

    // -------------------------------------------------------------- composer

    /**
     * Characters that cannot start a Chinese sentence. The recognizer punctuates every
     * pause as a sentence break, so a full stop in front of one of these is an artifact
     * of a mid-sentence breath, not a real boundary.
     */
    const CONTINUATION = '的地得着过吗呢吧呀嘛哈了是和与跟及或也就都还又而却被把给对向从于太很更最会能'
    /** One-syllable hesitation the recognizer keeps between two breaks. */
    const FILLERS = '嗯啊呃唔哦诶唉'
    const CJK_RANGE = '\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef'

    /** Normalize model output for inline insertion: spacing and punctuation repair. */
    function tidy(text) {
      let out = String(text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (!out) return ''
      // Chinese text carries no spaces inside a run of characters and none around its
      // punctuation; spaces only belong between Latin words or next to Latin words.
      out = out.replace(new RegExp(`([${CJK_RANGE}]) +(?=[${CJK_RANGE}])`, 'g'), '$1')
      out = out.replace(/([，。！？；：、）】」』]) +/g, '$1')
      out = out.replace(/ +([，。！？；：、])/g, '$1')
      // A breath pause must not split a sentence in two.
      out = out.replace(new RegExp(`([。！？])\\s*(?=[${CONTINUATION}])`, 'g'), '')
      // Drop a hesitation syllable the model heard between two breaks.
      out = out.replace(new RegExp(`([。！？])\\s*[，、]?\\s*[${FILLERS}][，、]\\s*`, 'g'), '$1')
      // One mark where the model doubled it, and prefer the stronger of the two.
      out = out.replace(/([，。！？；：])\s*\1+/g, '$1')
      out = out.replace(/[，、]\s*([。！？])/g, '$1')
      out = out.replace(/([。！？])\s*[，、]\s*/g, '$1')
      out = out.replace(/^[\s，。！？；：、]+/, '')
      return out.replace(/\s+$/, '')
    }

    /**
     * Replace the tracked partial region with `text`; an empty text clears it.
     * Re-anchors at the caret when another edit invalidated the region.
     */
    function writePartial(current, text) {
      const api = current.actions
      if (!api) return false
      if (current.region) {
        const revision = api.captureInsertion().draftRev
        if (api.insertText(text, { start: current.region.start, end: current.region.end, draftRev: revision })) {
          current.region.end = current.region.start + text.length
          current.partial = text
          current.touched = true
          store.set({ partial: text })
          return true
        }
        current.region = null
      }
      if (text === '') return true
      for (let attempt = 0; attempt < 2; attempt++) {
        const caret = api.captureInsertion()
        if (api.insertText(text, { start: caret.start, end: caret.start, draftRev: caret.draftRev })) {
          current.region = { start: caret.start, end: caret.start + text.length }
          current.partial = text
          current.touched = true
          store.set({ partial: text })
          return true
        }
      }
      return false
    }

    // ------------------------------------------------------------ capture I/O

    async function openCapture(current) {
      const media = navigator.mediaDevices
      if (!media || !media.getUserMedia) throw new Error(copy.unavailable)
      let stream
      try {
        stream = await media.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false,
        })
      } catch (error) {
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
        throw new Error(denied ? copy.denied : copy.unavailable)
      }
      if (current.stopping) { stream.getTracks().forEach((track) => track.stop()); throw new Error('cancelled') }
      const context = new AudioContext()
      try { if (context.state === 'suspended' && context.resume) await context.resume() } catch (_error) { /* keep going */ }
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const mute = context.createGain()
      mute.gain.value = 0
      const resampler = new Resampler(context.sampleRate)
      processor.onaudioprocess = (event) => {
        if (run !== current || current.stopping) return
        append(current, resampler.push(event.inputBuffer.getChannelData(0)))
      }
      // Sink into a MediaStream destination rather than the speakers: connecting to
      // `context.destination` makes Chromium bypass echo cancellation, which let speaker
      // output leak back into the transcript.
      const sink = context.createMediaStreamDestination()
      source.connect(processor)
      processor.connect(mute)
      mute.connect(sink)
      current.capture = { stream, context, source, processor, mute, sink }
    }

    async function closeCapture(current) {
      const capture = current.capture
      current.capture = null
      if (!capture) return
      try { capture.processor.onaudioprocess = null } catch (_error) { /* ignore */ }
      try { capture.processor.disconnect(); capture.source.disconnect(); capture.mute.disconnect() } catch (_error) { /* ignore */ }
      try { capture.sink.disconnect() } catch (_error) { /* ignore */ }
      try { capture.stream.getTracks().forEach((track) => track.stop()) } catch (_error) { /* ignore */ }
      try { if (capture.context.state !== 'closed') await capture.context.close() } catch (_error) { /* ignore */ }
    }

    // ----------------------------------------------------------------- flow

    function dialogOpen() {
      const nodes = document.querySelectorAll('[role="dialog"], [aria-modal="true"]')
      for (const node of nodes) {
        if (!node || node.nodeType !== 1) continue
        const style = window.getComputedStyle(node)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
        const rect = node.getBoundingClientRect()
        if (rect.width < 2 || rect.height < 2) continue
        return true
      }
      return false
    }

    function begin() {
      if (run) return
      try {
        if (!actions) { store.set({ phase: 'idle', error: copy.notReady }); return }
        if (locked) { store.set({ phase: 'idle', error: copy.busy }); return }
        if (dialogOpen()) { store.set({ phase: 'idle', error: copy.busy }); return }
        const remote = speech()
        if (!remote) {
          store.set({ phase: 'idle', error: copy.noService + (speechDiag ? ' · ' + speechDiag : '') })
          return
        }
        const current = {
          id: ++generation,
          actions,
          remote,
          catalog: null,
          chunks: [],
          base: 0,
          total: 0,
          segStart: 0,
          region: null,
          partial: '',
          touched: false,
          tail: '',
          lastPassEnd: 0,
          inflight: false,
          stopping: false,
          cancelled: false,
          capture: null,
          timer: 0,
          abort: new AbortController(),
          startedAt: Date.now(),
        }
        run = current
        store.set({ phase: 'starting', text: '', error: '', partial: '', elapsedMs: 0 })
        void boot(current)
      } catch (error) {
        run = null
        store.set({ phase: 'idle', error: failureText(error, copy.failed) })
      }
    }

    async function boot(current) {
      try {
        current.catalog = await catalogOf(current.remote)
        const provider = (current.catalog.providers || []).find((item) => item.id === current.catalog.selection.providerId)
        const phase = provider && provider.preparation ? provider.preparation.phase : 'ready'
        if (phase === 'unprepared') {
          store.set({ phase: 'starting', error: copy.preparing })
          try { await current.remote.prepare(current.catalog.selection.providerId) } catch (_error) { /* queued */ }
        } else if (phase === 'failed') {
          throw new Error(copy.failed)
        }
        if (run !== current) return
        await openCapture(current)
      } catch (error) {
        const cancelled = current.stopping
        if (run === current) run = null
        await closeCapture(current)
        if (!cancelled) store.set({ phase: 'idle', error: failureText(error, copy.failed) })
        return
      }
      if (run !== current) { await closeCapture(current); return }
      store.set({ phase: 'recording' })
      current.timer = setInterval(() => { void tick(current) }, TICK_MS)
    }

    async function tick(current) {
      if (run !== current || current.inflight || current.stopping) return
      const end = current.total
      const length = end - current.segStart
      if (length < RATE * (MIN_WINDOW_MS / 1000)) return
      if (length >= RATE * (MAX_WINDOW_MS / 1000)) {
        void stop('keyup').catch(() => undefined)
        return
      }
      // Re-transcribe the utterance from its start, so one pass refines the whole
      // sentence instead of locking in short fragments. The required growth widens with
      // the utterance, so a long hold does not queue slower and slower passes.
      const growth = Math.max(GROWTH_MS, Math.min(4000, (length / RATE) * 250))
      if (current.lastPassEnd > 0 && end - current.lastPassEnd < RATE * (growth / 1000)) return
      current.inflight = true
      try {
        const text = await transcribeRange(current, current.remote, current.segStart, end)
        if (run !== current || current.stopping) return
        current.lastPassEnd = end
        if (text) {
          writePartial(current, tidy(text))
          current.tail = text.slice(-1)
        }
        store.set({ text: text || '', error: '' })
      } catch (error) {
        if (current.abort.signal.aborted) return
        store.set({ error: failureText(error, copy.failed) })
      } finally {
        current.inflight = false
      }
    }

    /** Write through the composer, tolerating a composer that is already gone. */
    function safePartial(current, text) {
      try {
        writePartial(current, text)
      } catch (_error) {
        // The Session's composer may have been disposed while capture was still open.
      }
    }

    async function stop(reason) {
      const current = run
      if (!current) return
      run = null
      clearInterval(current.timer)
      current.stopping = true
      try {
        if (reason === 'cancel') {
          current.abort.abort()
          safePartial(current, '')
          return
        }
        store.set({ phase: 'transcribing' })
        await closeCapture(current)
        const end = current.total
        const pending = end - current.segStart
        let text = ''
        if (pending >= RATE * 0.15) {
          try {
            // Pad the tail with a little silence: capture stops on keyup, and without a
            // quiet tail the model tends to clip the final syllable.
            const samples = slice(current, current.segStart, end)
            const padded = new Float32Array(samples.length + Math.round(RATE * 0.15))
            padded.set(samples)
            text = await transcribeSamples(current, current.remote, padded)
          } catch (error) {
            if (!current.abort.signal.aborted) store.set({ error: failureText(error, copy.failed) })
          }
        }
        // The closing pass sees the whole utterance, so it replaces every earlier guess.
        if (text) safePartial(current, tidy(text))
      } finally {
        await closeCapture(current).catch(() => undefined)
        current.region = null
        current.touched = false
        current.chunks = []
        store.set({ phase: 'idle', text: '', partial: '', elapsedMs: 0 })
      }
    }

    // -------------------------------------------------------------- keyboard

    function onKeyDown(event) {
      const key = event.key
      // Modifier keys are read before the composition guard: with an IME active in the
      // composer, Chromium reports isComposing on these keydowns and Alt would be lost.
      if (key === 'Alt' || key === 'AltGraph' || key === 'OS') {
        if (event.repeat || altHeld) return
        if (event.ctrlKey || event.metaKey) return
        altHeld = true
        store.set({ seen: key })
        event.preventDefault()
        begin()
        return
      }
      if (!altHeld || !run) return
      if (key === 'Escape') {
        event.preventDefault()
        altHeld = false
        void stop('cancel').catch(() => undefined)
        return
      }
      if (key && !MODIFIERS.has(key) && key !== 'Process') {
        altHeld = false
        void stop('cancel').catch(() => undefined)
      }
    }

    function onKeyUp(event) {
      const key = event.key
      if (key !== 'Alt' && key !== 'AltGraph') return
      store.set({ seen: '' })
      if (!altHeld) return
      altHeld = false
      if (run) void stop('keyup').catch(() => undefined)
    }

    /** Start a dictation from the pill itself, mouse or pen. */
    function startFromPointer() {
      store.set({ seen: 'mouse' })
      pointerHeld = true
      begin()
    }

    function onPointerDownCapture(event) {
      const target = event.target
      if (target && target.closest && target.closest('[data-push-to-talk]')) return
      if (run) return
      const pill = document.querySelector('[data-push-to-talk]')
      if (!pill) return
      const rect = pill.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return
      const x = event.clientX
      const y = event.clientY
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return
      event.preventDefault()
      startFromPointer()
    }

    function onPointerUpCapture() {
      if (!pointerHeld) return
      pointerHeld = false
      store.set({ seen: '' })
      if (run) void stop('keyup').catch(() => undefined)
    }

    function onBlur() {
      altHeld = false
      pointerHeld = false
      store.set({ seen: '' })
      if (run) void stop('blur').catch(() => undefined)
    }

    function onVisibility() {
      if (document.hidden && run) onBlur()
    }

    // ------------------------------------------------------------ indicator

    function bind(nextActions, nextLocked) {
      actions = nextActions
      locked = Boolean(nextLocked)
    }

    function unbind(nextActions) {
      if (actions !== nextActions) return
      actions = null
      if (run) void stop('blur').catch(() => undefined)
    }

    const MIC_PATH = 'M12 4a2 2 0 0 0-2 2v6a2 2 0 0 0 4 0V6a2 2 0 0 0-2-2Zm6 8a6 6 0 0 1-12 0M12 18v3'

    function Mic(color) {
      return h('svg', {
        'aria-hidden': true,
        width: 14,
        height: 14,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: color,
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { flex: '0 0 auto' },
      }, h('path', { d: MIC_PATH }))
    }

    function Indicator(props) {
      const inputActions = props.inputActions
      const [snapshot, setSnapshot] = React.useState(store.get)

      React.useEffect(() => store.subscribe(() => setSnapshot(store.get())), [])
      React.useEffect(() => {
        bind(inputActions, props.locked)
        return () => unbind(inputActions)
      }, [inputActions, props.locked])

      const error = snapshot.error
      const label = snapshot.phase === 'starting' ? copy.starting
        : snapshot.phase === 'recording' ? copy.recording
          : snapshot.phase === 'transcribing' ? copy.transcribing
            : ''
      const color = error ? 'var(--dsw-alias-state-error-primary, #d9534f)'
        : snapshot.phase === 'recording' ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
          : 'var(--dsw-alias-label-secondary, #888)'
      const detail = snapshot.partial ? snapshot.partial.slice(-18) : ''
      const text = error || label

      return h('button', {
        type: 'button',
        role: 'status',
        'data-push-to-talk': snapshot.phase,
        title: error || copy.hint,
        'aria-label': copy.hint,
        onPointerDown: (event) => {
          event.preventDefault()
          startFromPointer()
        },
        onPointerUp: (event) => {
          event.preventDefault()
          pointerHeld = false
          store.set({ seen: '' })
          if (run) void stop('keyup').catch(() => undefined)
        },
        onPointerCancel: () => {
          pointerHeld = false
          store.set({ seen: '' })
          if (run) void stop('keyup').catch(() => undefined)
        },
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          minHeight: 26,
          maxWidth: 300,
          padding: '2px 8px',
          borderRadius: 999,
          border: '1px solid ' + (error
            ? 'var(--dsw-alias-state-error-primary, #d9534f)'
            : snapshot.phase === 'recording'
              ? 'var(--dsw-alias-brand-primary, #4d6bfe)'
              : 'var(--dsw-alias-border-l1, #e3e3e3)'),
          background: snapshot.phase === 'recording'
            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 14%, transparent)'
            : 'transparent',
          color: error ? 'var(--dsw-alias-state-error-primary, #d9534f)' : 'var(--dsw-alias-label-secondary, #888)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: 1.4,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
        },
      },
      Mic(color),
      text ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } },
        detail ? text + ' · ' + detail : text) : null,
      text ? null : h('kbd', {
        style: {
          fontSize: 10,
          letterSpacing: '0.02em',
          padding: '1px 4px',
          borderRadius: 4,
          border: '1px solid var(--dsw-alias-border-l1, #e3e3e3)',
        },
      }, copy.altKey),
      // Turns green the first time a key press actually reaches the listener.
      h('span', {
        'aria-hidden': true,
        style: {
          width: 5,
          height: 5,
          borderRadius: 999,
          flex: '0 0 auto',
          background: snapshot.seen
            ? 'var(--dsw-alias-state-success-primary, #22a06b)'
            : 'var(--dsw-alias-border-l2, #d9d9d9)',
        },
      }))
    }

    // ---------------------------------------------------------------- plugin

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        ctxRef = ctx
        // The speech namespace is gated behind an explicit service injection, so it is
        // resolved here once and cached for `begin()`.
        ctx.effect(() => {
          try {
            speechRef = ctx.get ? ctx.get('remote.speech') : null
          } catch (_error) {
            speechRef = null
          }
          if (speechRef) return () => { speechRef = null }
          if (typeof ctx.inject !== 'function') return undefined
          let scope = null
          try {
            scope = ctx.inject(['remote.speech'], (inner) => {
              try { speechRef = inner.remote.speech } catch (_error) { speechRef = null }
            })
          } catch (_error) {
            scope = null
          }
          return () => {
            speechRef = null
            try { if (scope && scope.dispose) scope.dispose() } catch (_error) { /* ignore */ }
          }
        }, 'push-to-talk: speech remote')
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: NS,
          order: 41,
        }, Indicator))
        ctx.effect(() => {
          // Both window and document, in the capture phase: whichever the composer or a
          // shortcut plugin lets through first is enough to see the Alt press.
          window.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('keyup', onKeyUp, true)
          document.addEventListener('keydown', onKeyDown, true)
          document.addEventListener('keyup', onKeyUp, true)
          window.addEventListener('blur', onBlur)
          document.addEventListener('visibilitychange', onVisibility)
          // The composer bar may sit under an ancestor with `pointer-events: none`, so the
          // pill is also reachable through a coordinate hit test on capture.
          document.addEventListener('pointerdown', onPointerDownCapture, true)
          document.addEventListener('pointerup', onPointerUpCapture, true)
          document.addEventListener('pointercancel', onPointerUpCapture, true)
          return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('keyup', onKeyUp, true)
            document.removeEventListener('keydown', onKeyDown, true)
            document.removeEventListener('keyup', onKeyUp, true)
            window.removeEventListener('blur', onBlur)
            document.removeEventListener('visibilitychange', onVisibility)
            document.removeEventListener('pointerdown', onPointerDownCapture, true)
            document.removeEventListener('pointerup', onPointerUpCapture, true)
            document.removeEventListener('pointercancel', onPointerUpCapture, true)
            if (run) void stop('blur').catch(() => undefined)
          }
        }, 'push-to-talk: keyboard capture')
      },
    }
  },
})
