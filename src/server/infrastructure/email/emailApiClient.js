/**
 * Cliente do microsserviço externo "Sirius Email API" (processo separado, ex.: localhost:8037).
 * EMAIL_API_URL deve apontar para a raiz do serviço (sem /email/enviar no final).
 */
async function enviarEmail({ to, subject, html, text }) {
  const baseUrl = process.env.EMAIL_API_URL;
  if (!baseUrl) throw new Error('EMAIL_API_URL não configurada');

  const res = await fetch(`${baseUrl}/email/enviar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.EMAIL_API_KEY,
    },
    body: JSON.stringify({ to, subject, html, text }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.message || `Email API respondeu ${res.status}`);
  }
  return data;
}

module.exports = { enviarEmail };
