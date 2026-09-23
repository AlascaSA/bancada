// Saúde do que a Bancada usa de fora: chave da Groq e acesso ao Drive (o refresh token do Google vence em 7 dias
// enquanto o app OAuth estiver em «Testing»; quando vence, visualizador, «Aprovar», vigia e robô param juntos).
import { configurado, token } from '../_drive.js';
export async function onRequestGet({ env }) {
  let drive = 'sem-config';
  if (configurado(env)) { try { await token(env); drive = 'ok'; } catch (e) { drive = /invalid_grant/.test(e.message) ? 'vencido' : 'erro'; } }
  return Response.json({ groq: !!env.GROQ_KEY, drive }, { headers: { 'Cache-Control': 'no-store' } });
}
