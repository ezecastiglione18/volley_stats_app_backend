import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';
import * as nodemailer from 'nodemailer';

import { db } from './firestore';

/** Casilla de destino de los reportes. Es un parámetro de la función (no va
 * escrito en la app): se define en `functions/.env` y se cambia con un deploy,
 * sin publicar otra versión de la app. */
export const feedbackTo = defineString('FEEDBACK_TO');

/** Cuenta de Gmail desde la que se manda el mail y su contraseña de
 * aplicación (requiere verificación en dos pasos). Se cargan con
 * `firebase functions:secrets:set`, o en `functions/.secret.local` para el
 * emulador. */
export const gmailUser = defineSecret('GMAIL_USER');
export const gmailAppPassword = defineSecret('GMAIL_APP_PASSWORD');

// --- Límites (los mismos que valida la app en feedback_screen.dart) ---
export const NAME_MAX = 80;
export const EMAIL_MAX = 254;
export const COMMENT_MIN = 10;
export const COMMENT_MAX = 2000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Envíos permitidos por cuenta dentro de la ventana. Un envío exitoso NO
 * reinicia el contador (a diferencia del canje de códigos): si no, el límite
 * no frenaría a nadie. */
export const MAX_SUBMISSIONS_PER_WINDOW = 5;
export const SUBMISSIONS_WINDOW_MS = 60 * 60 * 1000;

/** Los reportes se conservan 12 meses (campo `expireAt`, que borra la política
 * TTL de Firestore sobre la colección `feedback`; ver README). */
const RETENTION_MONTHS = 12;

export interface FeedbackDiagnostics {
  appVersion: string;
  platform: string;
  osVersion: string;
  plan: string;
  cloudEnabled: boolean | null;
  locale: string;
}

export interface ValidFeedback {
  name: string | null;
  contactEmail: string | null;
  comment: string;
  diagnostics: FeedbackDiagnostics;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}

export interface FeedbackDeps {
  /** Manda el mail. Se inyecta para poder probar sin SMTP real. */
  sendMail: (message: MailMessage) => Promise<void>;
  /** Destino (FEEDBACK_TO). */
  to: string;
  now?: () => number;
}

/** Saca caracteres de control (saltos de línea incluidos): lo que va al asunto
 * del mail nunca puede partir un encabezado. */
function clean(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return 'desconocido';
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return s === '' ? 'desconocido' : s;
}

function sanitizeDiagnostics(raw: unknown): FeedbackDiagnostics {
  const d = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const plan = d.plan === 'free' || d.plan === 'premium' ? d.plan : 'desconocido';
  return {
    appVersion: clean(d.appVersion, 32),
    platform: clean(d.platform, 32),
    osVersion: clean(d.osVersion, 200),
    plan,
    cloudEnabled: typeof d.cloudEnabled === 'boolean' ? d.cloudEnabled : null,
    locale: clean(d.locale, 35),
  };
}

/** Valida lo mismo que la app. Los campos desconocidos se ignoran; el
 * diagnóstico se sanea en vez de rechazarse, para no perder un reporte por una
 * diferencia de versiones entre la app y la función. */
export function validateFeedback(data: unknown): ValidFeedback {
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;

  let name: string | null = null;
  if (d.name !== undefined && d.name !== null) {
    if (typeof d.name !== 'string') throw new HttpsError('invalid-argument', 'El nombre no es valido');
    const n = d.name.trim();
    if (n.length > NAME_MAX) throw new HttpsError('invalid-argument', 'El nombre es demasiado largo');
    name = n === '' ? null : n;
  }

  let contactEmail: string | null = null;
  if (d.contactEmail !== undefined && d.contactEmail !== null) {
    if (typeof d.contactEmail !== 'string') {
      throw new HttpsError('invalid-argument', 'El mail no es valido');
    }
    const e = d.contactEmail.trim();
    if (e !== '') {
      if (e.length > EMAIL_MAX || !EMAIL_RE.test(e)) {
        throw new HttpsError('invalid-argument', 'El mail no es valido');
      }
      contactEmail = e;
    }
  }

  if (typeof d.comment !== 'string') throw new HttpsError('invalid-argument', 'Falta el comentario');
  const comment = d.comment.trim();
  if (comment.length < COMMENT_MIN || comment.length > COMMENT_MAX) {
    throw new HttpsError('invalid-argument', 'El comentario debe tener entre 10 y 2000 caracteres');
  }

  return { name, contactEmail, comment, diagnostics: sanitizeDiagnostics(d.diagnostics) };
}

/** Consume un envío de la cuenta en feedback_attempts/{uid} (transacción, para
 * que pedidos simultáneos no se cuelen). Mismo patrón que `takeAttempt` de
 * redeemPromoCode, incluido el fail-open: si el contador falla, se deja pasar
 * antes que bloquear un reporte legítimo. */
async function takeAttempt(uid: string, now: number): Promise<boolean> {
  const ref = db.collection('feedback_attempts').doc(uid);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const windowStart = snap.data()?.windowStart as number | undefined;
      if (windowStart === undefined || now - windowStart >= SUBMISSIONS_WINDOW_MS) {
        tx.set(ref, { count: 1, windowStart: now });
        return true;
      }
      const count = (snap.data()?.count as number | undefined) ?? 0;
      if (count >= MAX_SUBMISSIONS_PER_WINDOW) return false;
      tx.update(ref, { count: FieldValue.increment(1) });
      return true;
    });
  } catch (err) {
    logger.error('submitFeedback: no se pudo registrar el envio, se deja pasar', {
      uid,
      error: String(err),
    });
    return true;
  }
}

/** Devuelve el envío consumido cuando el reporte no llegó a guardarse (no es
 * culpa del usuario). "Best effort". */
async function releaseAttempt(uid: string): Promise<void> {
  try {
    await db.collection('feedback_attempts').doc(uid).update({ count: FieldValue.increment(-1) });
  } catch (err) {
    logger.error('submitFeedback: no se pudo devolver el envio', { uid, error: String(err) });
  }
}

function buildMail(uid: string, f: ValidFeedback, to: string): MailMessage {
  const d = f.diagnostics;
  const cloud = d.cloudEnabled === null ? 'desconocido' : d.cloudEnabled ? 'si' : 'no';
  const text = [
    `Nombre: ${f.name ?? '(no indicado)'}`,
    `Mail: ${f.contactEmail ?? '(no indicado: no se puede responder)'}`,
    '',
    'Comentario:',
    f.comment,
    '',
    'Diagnostico:',
    `- Version de la app: ${d.appVersion}`,
    `- Plataforma: ${d.platform} ${d.osVersion}`,
    `- Plan: ${d.plan}`,
    `- Nube activada: ${cloud}`,
    `- Idioma: ${d.locale}`,
    '',
    `Cuenta (uid): ${uid}`,
  ].join('\n');
  return {
    to,
    subject: `[RallyStats] Reporte · v${d.appVersion} · ${d.platform}`,
    text,
    ...(f.contactEmail ? { replyTo: f.contactEmail } : {}),
  };
}

/**
 * Lógica de `submitFeedback`, separada del `onCall` para poder probarla con el
 * emulador de Firestore sin credenciales de Gmail. Orden (un reporte nunca se
 * pierde): validar → límite → GUARDAR en Firestore → recién ahí intentar el
 * mail → marcar `sent` o `failed`. Devuelve { ok: true } aunque el mail falle,
 * porque el reporte quedó guardado.
 */
export async function processFeedback(
  uid: string | undefined,
  data: unknown,
  deps: FeedbackDeps,
): Promise<{ ok: true }> {
  if (!uid) throw new HttpsError('unauthenticated', 'Hay que iniciar sesion');
  const now = (deps.now ?? Date.now)();

  // Se valida antes de consumir el límite: un mail mal escrito no gasta un envío.
  const feedback = validateFeedback(data);

  if (!(await takeAttempt(uid, now))) {
    logger.warn('submitFeedback: cuenta sin envios disponibles', { uid });
    throw new HttpsError('resource-exhausted', 'Demasiados reportes, proba mas tarde');
  }

  const expireAt = new Date(now);
  expireAt.setMonth(expireAt.getMonth() + RETENTION_MONTHS);

  // 1) Guardar. Si esto falla no se manda nada y la app conserva el texto.
  let ref;
  try {
    ref = await db.collection('feedback').add({
      uid,
      name: feedback.name,
      contactEmail: feedback.contactEmail,
      comment: feedback.comment,
      diagnostics: feedback.diagnostics,
      createdAt: FieldValue.serverTimestamp(),
      expireAt: Timestamp.fromDate(expireAt),
      status: 'pending',
    });
  } catch (err) {
    logger.error('submitFeedback: no se pudo guardar el reporte', { uid, error: String(err) });
    await releaseAttempt(uid);
    throw new HttpsError('internal', 'No se pudo guardar el reporte, proba de nuevo');
  }

  // 2) Mail. Cualquier falla deja el documento en "failed" y queda en los logs.
  let status: 'sent' | 'failed' = 'sent';
  try {
    if (!deps.to) throw new Error('FEEDBACK_TO vacio');
    await deps.sendMail(buildMail(uid, feedback, deps.to));
  } catch (err) {
    status = 'failed';
    logger.error('submitFeedback: fallo el envio del mail, el reporte quedo guardado', {
      uid,
      feedbackId: ref.id,
      error: String(err),
    });
  }

  try {
    await ref.update({ status });
  } catch (err) {
    logger.error('submitFeedback: no se pudo actualizar el estado', {
      uid,
      feedbackId: ref.id,
      status,
      error: String(err),
    });
  }

  logger.info('submitFeedback: reporte recibido', { uid, feedbackId: ref.id, status });
  return { ok: true };
}

/** Manda el mail por SMTP de Gmail. Los timeouts son cortos para que el estado
 * del reporte se actualice antes de que venza la función. */
function gmailSender(user: string, pass: string): FeedbackDeps['sendMail'] {
  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 15000,
  });
  return async (m) => {
    await transport.sendMail({
      from: `RallyStats <${user}>`,
      to: m.to,
      subject: m.subject,
      text: m.text,
      ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    });
  };
}

/**
 * Recibe un reporte de error o consulta desde Configuración de la app. Pide
 * sesión (el uid sale de ahí, no lo manda la app), valida, aplica el límite de
 * 5 envíos por hora por cuenta, guarda en `feedback/{id}` y manda el mail.
 */
export const submitFeedback = onCall(
  // maxInstances: tope de gasto si alguien le pega en masa a la función.
  { region: 'southamerica-east1', secrets: [gmailUser, gmailAppPassword], maxInstances: 10 },
  (request) =>
    processFeedback(request.auth?.uid, request.data, {
      sendMail: gmailSender(gmailUser.value(), gmailAppPassword.value()),
      to: feedbackTo.value(),
    }),
);
