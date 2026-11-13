// Pruebas de submitFeedback contra el emulador de Firestore (sin SMTP real: el
// envío del mail se simula). Se corre con `npm test`, que levanta el emulador
// (necesita Java 21 o más: ver README, "Tests").
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { db } = require('../lib/firestore');
const { processFeedback, validateFeedback } = require('../lib/submitFeedback');

const DIAG = {
  appVersion: '1.4.1+20',
  platform: 'android',
  osVersion: 'Android 15',
  plan: 'premium',
  cloudEnabled: true,
  locale: 'es-AR',
};
const valid = (extra = {}) => ({
  name: 'Martin',
  contactEmail: 'martin@example.com',
  comment: 'Al deshacer en el set 3 me borro un punto.',
  diagnostics: DIAG,
  ...extra,
});

let uidCounter = 0;
const newUid = () => `uid-test-${Date.now()}-${uidCounter++}`;

/** Mail simulado: guarda lo que se habría mandado. */
function okMailer() {
  const sent = [];
  return { sent, sendMail: async (m) => void sent.push(m), to: 'destino@example.com' };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    return true;
  });
}

async function feedbackOf(uid) {
  const snap = await db.collection('feedback').where('uid', '==', uid).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

test('sin sesion se rechaza y no guarda nada', async () => {
  const deps = okMailer();
  await rejects(processFeedback(undefined, valid(), deps), 'unauthenticated');
  assert.equal(deps.sent.length, 0);
});

test('datos invalidos se rechazan (y no gastan un envio)', async () => {
  const uid = newUid();
  const deps = okMailer();
  const bad = [
    valid({ comment: '123456789' }), // 9 caracteres
    valid({ comment: 'x'.repeat(2001) }),
    valid({ comment: undefined }),
    valid({ comment: '         \n        ' }), // solo espacios
    valid({ contactEmail: 'no-es-un-mail' }),
    valid({ name: 'n'.repeat(81) }),
    valid({ name: 42 }),
  ];
  for (const data of bad) {
    await rejects(processFeedback(uid, data, deps), 'invalid-argument');
  }
  assert.equal((await feedbackOf(uid)).length, 0);
  assert.equal(deps.sent.length, 0);
  // Siguen disponibles los 5 envios: ninguno de los rechazos consumio intentos.
  for (let i = 0; i < 5; i++) await processFeedback(uid, valid(), deps);
});

test('limites exactos: 10 y 2000 caracteres pasan; mail y nombre vacios son opcionales', () => {
  assert.equal(validateFeedback(valid({ comment: 'x'.repeat(10) })).comment.length, 10);
  assert.equal(validateFeedback(valid({ comment: 'x'.repeat(2000) })).comment.length, 2000);
  const anon = validateFeedback({ comment: 'x'.repeat(10), name: '  ', contactEmail: '' });
  assert.equal(anon.name, null);
  assert.equal(anon.contactEmail, null);
  assert.equal(validateFeedback(valid({ name: 'n'.repeat(80) })).name.length, 80);
});

test('campos desconocidos se ignoran y el diagnostico se sanea', () => {
  const f = validateFeedback(
    valid({
      uid: 'otro-uid',
      status: 'sent',
      diagnostics: { ...DIAG, platform: 'android\r\nBcc: x@y.z', plan: 'gold', extra: 1 },
    }),
  );
  assert.equal(f.uid, undefined);
  assert.equal(f.diagnostics.plan, 'desconocido');
  assert.ok(!/[\r\n]/.test(f.diagnostics.platform));
  assert.equal(f.diagnostics.extra, undefined);
});

test('con el mail simulado el documento pasa a "sent"', async () => {
  const uid = newUid();
  const deps = okMailer();
  const res = await processFeedback(uid, valid(), deps);
  assert.deepEqual(res, { ok: true });

  const [doc] = await feedbackOf(uid);
  assert.equal(doc.status, 'sent');
  assert.equal(doc.uid, uid);
  assert.equal(doc.name, 'Martin');
  assert.equal(doc.contactEmail, 'martin@example.com');
  assert.deepEqual(doc.diagnostics, DIAG);
  assert.ok(doc.createdAt);
  assert.ok(doc.expireAt.toMillis() > doc.createdAt.toMillis() + 360 * 24 * 3600 * 1000);

  assert.equal(deps.sent.length, 1);
  const m = deps.sent[0];
  assert.equal(m.to, 'destino@example.com');
  assert.equal(m.subject, '[RallyStats] Reporte · v1.4.1+20 · android');
  assert.equal(m.replyTo, 'martin@example.com');
  assert.ok(m.text.includes('Al deshacer en el set 3'));
  assert.ok(m.text.includes(uid));
});

test('un reporte anonimo no lleva replyTo', async () => {
  const uid = newUid();
  const deps = okMailer();
  await processFeedback(uid, valid({ name: '', contactEmail: '' }), deps);
  assert.equal(deps.sent[0].replyTo, undefined);
  const [doc] = await feedbackOf(uid);
  assert.equal(doc.contactEmail, null);
});

test('si el mail tira error queda en "failed" y la funcion igual devuelve ok', async () => {
  const uid = newUid();
  const deps = {
    to: 'destino@example.com',
    sendMail: async () => {
      throw new Error('535 Username and Password not accepted');
    },
  };
  const res = await processFeedback(uid, valid(), deps);
  assert.deepEqual(res, { ok: true });
  const [doc] = await feedbackOf(uid);
  assert.equal(doc.status, 'failed');
  assert.equal(doc.comment, valid().comment); // el reporte no se perdio
});

test('sin FEEDBACK_TO el reporte queda guardado en "failed"', async () => {
  const uid = newUid();
  const res = await processFeedback(uid, valid(), { to: '', sendMail: async () => {} });
  assert.deepEqual(res, { ok: true });
  assert.equal((await feedbackOf(uid))[0].status, 'failed');
});

test('el sexto envio dentro de la hora se rechaza', async () => {
  const uid = newUid();
  const deps = okMailer();
  let now = 1_800_000_000_000;
  for (let i = 0; i < 5; i++) await processFeedback(uid, valid(), { ...deps, now: () => now });
  await rejects(processFeedback(uid, valid(), { ...deps, now: () => now + 1000 }), 'resource-exhausted');
  assert.equal((await feedbackOf(uid)).length, 5);
  assert.equal(deps.sent.length, 5);

  // Otra cuenta no se ve afectada.
  await processFeedback(newUid(), valid(), deps);

  // Pasada la hora, la ventana se reinicia.
  now += 61 * 60 * 1000;
  await processFeedback(uid, valid(), { ...deps, now: () => now });
  assert.equal((await feedbackOf(uid)).length, 6);
});
