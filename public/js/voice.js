import { h, icon, toast } from './dom.js';

// Dictation via the browser's Web Speech API (Chrome, Edge, Safari). Returns null where unsupported.
export function voiceButton(getEl, { append = true } = {}) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  let rec = null;
  const btn = h('button', { type: 'button', class: 'icon-btn', title: 'Dictate', 'aria-label': 'Dictate with your voice' }, icon('mic', 18));
  const stop = () => { rec?.stop(); rec = null; btn.classList.remove('rec'); };
  btn.addEventListener('click', () => {
    if (rec) return stop();
    const el = getEl(); const base = append && el.value ? el.value.trimEnd() + ' ' : '';
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
    rec.onresult = e => { el.value = base + [...e.results].map(r => r[0].transcript).join(' '); el.dispatchEvent(new Event('input', { bubbles: true })); };
    rec.onerror = e => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Voice input: ' + e.error, 'error'); stop(); };
    rec.onend = () => { rec = null; btn.classList.remove('rec'); };
    try { rec.start(); btn.classList.add('rec'); } catch { stop(); }
  });
  return btn;
}
