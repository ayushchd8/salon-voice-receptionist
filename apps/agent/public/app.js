/*
 * Browser voice client.
 *
 * Real microphone, real speech recognition, real synthesized speech — no API
 * keys required, because both ends of the audio pipeline run in the browser
 * (Web Speech API in, SpeechSynthesis out). When a server-side TTS provider is
 * configured the server sends audio instead and this plays that; the rest of
 * the client is unchanged.
 *
 * Barge-in is handled here as well as on the server: the moment interim speech
 * arrives while the agent is talking, playback stops and the server is told to
 * abandon the turn in flight. Talking over a receptionist should interrupt
 * them, not queue behind them.
 */
(() => {
  'use strict';

  const el = (id) => document.getElementById(id);
  const ui = {
    salonName: el('salon-name'), salonSub: el('salon-sub'), providers: el('providers'),
    start: el('start'), mic: el('mic'), hangup: el('hangup'),
    status: el('status'), state: el('state'), listening: el('listening'),
    transcript: el('transcript'), composer: el('composer'), input: el('text-input'),
    send: el('send'), events: el('events'), hint: el('hint'),
  };

  let socket = null;
  let callId = null;
  let recognition = null;
  let recognising = false;
  let agentSpeaking = false;
  let currentAudio = null;
  let interimNode = null;

  // ── rendering ──────────────────────────────────────────────────────────────

  function addTurn(role, text, options = {}) {
    const node = document.createElement('div');
    node.className = `turn ${role}${options.interim ? ' interim' : ''}${options.guarded ? ' guarded' : ''}`;
    node.innerHTML = `<div class="who">${role}</div><div class="what"></div>`;
    node.querySelector('.what').textContent = text;
    ui.transcript.appendChild(node);
    ui.transcript.scrollTop = ui.transcript.scrollHeight;
    return node;
  }

  function addEvent(kind, text) {
    const li = document.createElement('li');
    li.className = kind;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<span class="t">${time}</span> `;
    li.appendChild(document.createTextNode(text));
    ui.events.appendChild(li);
    ui.events.scrollTop = ui.events.scrollHeight;
  }

  const setStatus = (text) => { ui.status.textContent = text; };
  const setState = (text) => { ui.state.textContent = text; };

  function chip(label) {
    const span = document.createElement('span');
    span.className = 'chip';
    span.textContent = label;
    return span;
  }

  // ── speaking ───────────────────────────────────────────────────────────────

  function stopSpeaking() {
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    agentSpeaking = false;
  }

  function speak(text, audioBase64, mimeType) {
    stopSpeaking();
    agentSpeaking = true;

    // Server-side TTS, when a provider is configured.
    if (audioBase64) {
      const audio = new Audio(`data:${mimeType || 'audio/mpeg'};base64,${audioBase64}`);
      currentAudio = audio;
      audio.onended = () => { agentSpeaking = false; currentAudio = null; };
      audio.play().catch(() => { agentSpeaking = false; });
      return;
    }

    // Zero-key path: the browser speaks.
    if (!window.speechSynthesis) { agentSpeaking = false; return; }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    const preferred = window.speechSynthesis
      .getVoices()
      .find((v) => /en-GB/.test(v.lang) && /female|Kate|Serena|Martha/i.test(v.name));
    if (preferred) utterance.voice = preferred;
    utterance.onend = () => { agentSpeaking = false; };
    window.speechSynthesis.speak(utterance);
  }

  // ── speech recognition ─────────────────────────────────────────────────────

  function setupRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      ui.hint.innerHTML =
        "Your browser has no speech recognition — <strong>type below instead</strong>. " +
        'Everything else (the agent, the tools, the guards) works identically. ' +
        'Chrome or Edge give you the full voice experience.';
      ui.mic.disabled = true;
      return null;
    }

    const rec = new Recognition();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-GB';

    rec.onstart = () => {
      recognising = true;
      ui.listening.hidden = false;
      ui.mic.classList.add('recording');
    };

    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }

      // Barge-in: the caller has started talking over the agent.
      if ((interim || final) && agentSpeaking) {
        stopSpeaking();
        send({ type: 'barge_in' });
        addEvent('state', 'barge-in — caller spoke over the agent');
      }

      if (interim) {
        if (!interimNode) interimNode = addTurn('caller', interim, { interim: true });
        else interimNode.querySelector('.what').textContent = interim;
      }

      if (final.trim()) {
        if (interimNode) { interimNode.remove(); interimNode = null; }
        submitUtterance(final.trim());
      }
    };

    rec.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        addEvent('error', `speech recognition: ${event.error}`);
      }
    };

    rec.onend = () => {
      recognising = false;
      ui.listening.hidden = true;
      ui.mic.classList.remove('recording');
      if (interimNode) { interimNode.remove(); interimNode = null; }
    };

    return rec;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  function send(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function submitUtterance(text) {
    addTurn('caller', text);
    setStatus('thinking');
    send({ type: 'user_text', text });
  }

  async function startCall() {
    ui.start.disabled = true;
    setStatus('connecting');

    let info;
    try {
      const response = await fetch('/v1/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A demo caller id, so the agent can recognise a returning customer.
        body: JSON.stringify({ callerPhone: '+447700900001' }),
      });
      info = await response.json();
      if (!response.ok) throw new Error(info?.error?.message || 'Could not start the call');
    } catch (err) {
      addTurn('system', String(err.message || err));
      addEvent('error', String(err.message || err));
      setStatus('failed');
      ui.start.disabled = false;
      return;
    }

    callId = info.callId;
    ui.salonName.textContent = info.salon.name;
    ui.salonSub.textContent = `${info.salon.timezone} · call ${callId.slice(0, 8)}`;
    ui.providers.replaceChildren(
      chip(`llm: ${info.providers.llm}`),
      chip(`stt: ${info.providers.stt}`),
      chip(`tts: ${info.providers.tts}`),
    );
    addEvent('state', `call started (${callId.slice(0, 8)})`);

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}/v1/calls/${callId}/stream`);

    socket.onopen = () => {
      setStatus('connected');
      ui.mic.disabled = !recognition;
      ui.hangup.disabled = false;
      ui.input.disabled = false;
      ui.send.disabled = false;
      addTurn('agent', info.greeting);
      speak(info.greeting);
    };

    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data);

      if (frame.type === 'ready') {
        setState(frame.state);
        return;
      }

      if (frame.type === 'thinking') {
        setStatus('thinking');
        return;
      }

      if (frame.type === 'barge_in') {
        stopSpeaking();
        return;
      }

      if (frame.type === 'agent_text') {
        setStatus('connected');
        setState(frame.state);
        addTurn('agent', frame.text, { guarded: frame.guardTripped });
        speak(frame.text, frame.audio, frame.mimeType);

        for (const tool of frame.toolsUsed || []) addEvent('tool', `tool · ${tool}`);
        addEvent('state', `state · ${frame.state}`);
        if (frame.guardTripped) {
          addEvent('guard', 'guard tripped — a false claim of success was suppressed');
        }
        return;
      }

      if (frame.type === 'ended') {
        setStatus('call ended');
        addEvent('state', 'call ended — summary written to the CRM');
        addTurn('system', 'Call ended. The structured summary is now visible in the CRM call-review screen.');
        teardown();
        return;
      }

      if (frame.type === 'error') {
        addTurn('system', frame.message);
        addEvent('error', frame.message);
      }
    };

    socket.onclose = () => {
      if (ui.status.textContent !== 'call ended') {
        setStatus('disconnected');
        teardown();
      }
    };
  }

  function teardown() {
    stopSpeaking();
    if (recognising && recognition) recognition.stop();
    ui.mic.disabled = true;
    ui.hangup.disabled = true;
    ui.input.disabled = true;
    ui.send.disabled = true;
    ui.start.disabled = false;
    ui.start.textContent = 'Start another call';
  }

  // ── wiring ─────────────────────────────────────────────────────────────────

  recognition = setupRecognition();

  ui.start.addEventListener('click', startCall);

  ui.hangup.addEventListener('click', () => {
    send({ type: 'end' });
    setStatus('call ended');
    teardown();
  });

  // Push-to-talk: hold to speak. Avoids the agent transcribing its own voice.
  const beginListening = (event) => {
    event.preventDefault();
    if (!recognition || recognising) return;
    stopSpeaking();
    try { recognition.start(); } catch { /* already started */ }
  };
  const endListening = () => {
    if (recognition && recognising) recognition.stop();
  };

  ui.mic.addEventListener('mousedown', beginListening);
  ui.mic.addEventListener('touchstart', beginListening, { passive: false });
  window.addEventListener('mouseup', endListening);
  window.addEventListener('touchend', endListening);

  ui.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = ui.input.value.trim();
    if (!text) return;
    ui.input.value = '';
    stopSpeaking();
    submitUtterance(text);
  });

  // Voice list loads asynchronously in some browsers.
  if (window.speechSynthesis) window.speechSynthesis.getVoices();
})();
