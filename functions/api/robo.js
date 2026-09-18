// Botão «Rodar o robô agora»: não espera o cron do vigia. Pede ao vigia (Worker) para olhar as pastas do
// Drive já e acordar o robô na nuvem.
//   POST /api/robo → o que o vigia respondeu: {acordou, motivos, esperando} ou {acordou:false, motivos:[], rodando}
//   GET  /api/robo → {rodando}: se há uma volta do robô em andamento no GitHub
const VIGIA = 'https://bancada-vigia.gu-costa-mendes.workers.dev';
const json = (o, status = 200) => Response.json(o, { status, headers: { 'Cache-Control': 'no-store' } });
export async function onRequest({ request, env }) {
  if (request.method !== 'GET' && request.method !== 'POST') return json({ erro: 'método' }, 405);
  try {
    const r = await fetch(env.VIGIA_URL || VIGIA, { method: request.method, headers: { 'User-Agent': 'bancada' } });
    return json(await r.json(), r.status);
  } catch (e) { return json({ erro: `vigia: ${e.message}` }, 502); }
}
