// Projetos: o que a mesa decidiu (cortes, legendas, transições, estilo, posição), a transcrição e a
// energia do áudio — nunca o vídeo. Reabrir = soltar os mesmos brutos (nome + tamanho) e a mesa volta
// em segundos, sem Groq. Guardado por professor no servidor (/api/projetos: KV na Cloudflare em
// produção, pasta em ~/Library/Application Support/Bancada/projetos no serve.py).
const base = '/api/projetos';
const ok = async (r, oque) => { if (!r.ok) throw new Error(`${oque}: ${r.status}`); return r; };
export const novoId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export async function listar(professor) { return (await (await ok(await fetch(`${base}?professor=${professor}`, { cache: 'no-store' }), 'lista')).json()).projetos; }
export async function carregar(professor, id) { return (await ok(await fetch(`${base}/${id}?professor=${professor}`, { cache: 'no-store' }), 'projeto')).json(); }
export async function gravar(proj) { return (await ok(await fetch(`${base}/${proj.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(proj) }), 'gravar')).json(); }
export async function gravarMidia(id, tipo, blob) { await ok(await fetch(`${base}/${id}/${tipo}`, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob }), tipo); }
export async function apagar(professor, id) { await ok(await fetch(`${base}/${id}?professor=${professor}`, { method: 'DELETE' }), 'apagar'); }
export const urlMidia = (id, tipo, v) => `${base}/${id}/${tipo}?v=${v || 0}`;

// envelope de energia (Float32 por 10 ms) → 1 byte por amostra em dB (−80..0 do pico), base64.
// 4 min de áudio = 26 KB. Erro de 0,3 dB não muda fronteira nenhuma na prática.
export function empacotarEnvelope(env) {
  let max = 0; for (const v of env) if (v > max) max = v;
  const u = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) { const db = env[i] > 0 && max > 0 ? 20 * Math.log10(env[i] / max) : -80; u[i] = Math.round(255 * Math.min(1, Math.max(0, 1 + db / 80))); }
  let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return { max, n: env.length, b64: btoa(s) };
}
export function desempacotarEnvelope(p) {
  const s = atob(p.b64), env = new Float32Array(p.n);
  for (let i = 0; i < p.n; i++) { const q = s.charCodeAt(i) / 255; env[i] = q <= 0 ? 0 : p.max * Math.pow(10, (q - 1) * 80 / 20); }
  return env;
}
export const mesmoArquivo = (a, f) => a.nome === f.name && a.tamanho === f.size;
export function haQuanto(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 50) return 'agora';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  if (s < 172800) return 'ontem';
  if (s < 7 * 86400) return `há ${Math.round(s / 86400)} dias`;
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}
