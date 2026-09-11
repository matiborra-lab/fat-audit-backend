/**
 * MAILER - envio de mails transaccionales (invitacion / reset de clave) via
 * Resend. Si no hay RESEND_API_KEY configurada (desarrollo local sin
 * cuenta de Resend todavia), el mail se loguea en consola en vez de
 * fallar - asi se puede seguir probando el flujo de invitacion copiando el
 * link del log.
 */

let resend = null;
if (process.env.RESEND_API_KEY) {
  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
}

// attachments: [{ filename, content: Buffer }] (opcional) - ej. el PDF de
// un informe de auditoría (ver src/pdf).
async function enviarMail({ to, subject, html, attachments }) {
  if (!resend) {
    console.log(`[mailer] RESEND_API_KEY no configurada - mail simulado a ${to}:\n  Asunto: ${subject}\n  ${html}${attachments ? `\n  Adjuntos: ${attachments.map((a) => a.filename).join(', ')}` : ''}`);
    return;
  }
  const from = process.env.MAIL_FROM || 'FAT Audit <no-responder@fataudit.com.ar>';
  const { error } = await resend.emails.send({
    from, to, subject, html,
    attachments: attachments?.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
  });
  if (error) throw new Error(error.message || 'Error enviando el mail');
}

module.exports = { enviarMail };
