export function onRequestGet({ env }) {
  return Response.json({ groq: !!env.GROQ_KEY }, { headers: { 'Cache-Control': 'no-store' } });
}
