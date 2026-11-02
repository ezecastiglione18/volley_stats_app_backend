/**
 * Script de administración: crea un documento en promo_codes. No se
 * despliega (no está exportado desde src/index.ts) — se corre a mano desde
 * esta máquina cada vez que hace falta un código nuevo.
 *
 * Apunta al emulador si FIRESTORE_EMULATOR_HOST está seteada (ver README,
 * sub-fase 1.3), o a producción si hay credenciales reales
 * (GOOGLE_APPLICATION_CREDENTIALS) — Admin SDK decide solo según el entorno.
 *
 * Uso: node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> <duracionDias|lifetime|fecha> [etiqueta] [--entitlement=<id>] [--until=<YYYY-MM-DD>]
 *      node lib/scripts/createPromoCode.js --random <cupo> <YYYY-MM-DD> <duracionDias|lifetime|fecha> [etiqueta] [--entitlement=<id>] [--until=<YYYY-MM-DD>]
 *
 * Con --random no se pasa <CODIGO>: se genera uno aleatorio de 12 caracteres
 * (imposible de adivinar, a diferencia de uno tipo PALABRA2026) y se imprime
 * al final. Preferir siempre --random para códigos nuevos.
 *
 * Ejemplos:
 *   node lib/scripts/createPromoCode.js --random 1 2026-12-31 30 "Prueba Juan"
 *   node lib/scripts/createPromoCode.js UNILIVO2026 50 2026-12-31 30 "Unilivo"
 *   node lib/scripts/createPromoCode.js DISPO1 1 2026-12-31 lifetime "Dispositivo extra" --entitlement=device_addon_1
 *   node lib/scripts/createPromoCode.js FINDEANIO 50 2026-10-31 fecha "Premium hasta fin de 2026" --until=2026-12-31
 *
 * Sin --entitlement, el código otorga premium (rallystats_pro).
 *
 * La fecha de la 3ª posición es hasta cuándo se puede CANJEAR el código. Con
 * --until, el otorgamiento termina en esa fecha fija (inclusive, 23:59 hora
 * Argentina) para todos, sin importar cuándo canjeen; en ese caso la duración
 * va como la palabra `fecha` (no se usan días).
 */
import { randomInt } from 'node:crypto';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

import { PREMIUM_ENTITLEMENT_ID, PROMO_ENTITLEMENT_IDS, PromoDuration } from '../revenuecat';

if (getApps().length === 0) {
  initializeApp();
}

const USAGE =
  'Uso: node lib/scripts/createPromoCode.js <CODIGO|--random> <cupo> <YYYY-MM-DD> <duracionDias|lifetime|fecha> [etiqueta] [--entitlement=<id>] [--until=<YYYY-MM-DD>]';

// 32 símbolos (sin I/O/0/1, que se confunden al dictarlos o copiarlos) x 12
// posiciones = 2^60 combinaciones. Sin guiones ni espacios: el campo de la app
// solo rechaza espacios, y el código tiene que viajar tal cual por WhatsApp.
const RANDOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RANDOM_CODE_LENGTH = 12;

function generateRandomCode(): string {
  let out = '';
  for (let i = 0; i < RANDOM_CODE_LENGTH; i++) {
    out += RANDOM_CODE_ALPHABET[randomInt(RANDOM_CODE_ALPHABET.length)];
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const entitlementFlag = args.find((a) => a.startsWith('--entitlement='));
  const untilFlag = args.find((a) => a.startsWith('--until='));
  const useRandom = args.includes('--random');
  const positional = args.filter((a) => !a.startsWith('--'));
  const [rawCode, maxRedemptionsRaw, expiresAtRaw, durationDaysRaw, label] = useRandom
    ? [generateRandomCode(), ...positional]
    : positional;

  if (!rawCode || !maxRedemptionsRaw || !expiresAtRaw || !durationDaysRaw) {
    console.error(USAGE);
    process.exit(1);
  }

  const entitlementId = entitlementFlag
    ? entitlementFlag.slice('--entitlement='.length)
    : PREMIUM_ENTITLEMENT_ID;
  if (!(PROMO_ENTITLEMENT_IDS as readonly string[]).includes(entitlementId)) {
    console.error(`Entitlement desconocido: ${entitlementId}. Validos: ${PROMO_ENTITLEMENT_IDS.join(', ')}`);
    process.exit(1);
  }

  const code = rawCode.trim().toUpperCase();
  const maxRedemptions = Number(maxRedemptionsRaw);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
    console.error('El cupo tiene que ser un entero positivo');
    process.exit(1);
  }

  // Fecha fija de fin del otorgamiento (inclusive, 23:59 hora Argentina).
  let premiumUntil: Date | undefined;
  if (untilFlag) {
    premiumUntil = new Date(`${untilFlag.slice('--until='.length)}T23:59:59-03:00`);
    if (Number.isNaN(premiumUntil.getTime())) {
      console.error('Fecha de --until invalida, usar YYYY-MM-DD');
      process.exit(1);
    }
    if (durationDaysRaw.toLowerCase() !== 'fecha') {
      console.error('Con --until, la duracion tiene que ser la palabra "fecha" (no se usan dias)');
      process.exit(1);
    }
  } else if (durationDaysRaw.toLowerCase() === 'fecha') {
    console.error('"fecha" solo se usa junto con --until=<YYYY-MM-DD>');
    process.exit(1);
  }

  let durationDays: PromoDuration | null;
  if (premiumUntil) {
    durationDays = null;
  } else if (durationDaysRaw.toLowerCase() === 'lifetime') {
    durationDays = 'lifetime';
  } else {
    durationDays = Number(durationDaysRaw);
    if (!Number.isInteger(durationDays) || durationDays <= 0) {
      console.error('La duracion tiene que ser un entero positivo, en dias (ej. 1, 30), o "lifetime"');
      process.exit(1);
    }
  }

  // Vence a las 23:59 hora Argentina del día indicado.
  const expiresAt = new Date(`${expiresAtRaw}T23:59:59-03:00`);
  if (Number.isNaN(expiresAt.getTime())) {
    console.error('Fecha de vencimiento invalida, usar YYYY-MM-DD');
    process.exit(1);
  }

  const db = getFirestore();
  const ref = db.collection('promo_codes').doc(code);

  const existing = await ref.get();
  if (existing.exists) {
    console.error(`El codigo ${code} ya existe, no se pisa. Borralo a mano primero si es a propósito.`);
    process.exit(1);
  }

  await ref.set({
    label: label ?? null,
    entitlementId,
    maxRedemptions,
    redeemedCount: 0,
    durationDays,
    ...(premiumUntil ? { premiumUntil: Timestamp.fromDate(premiumUntil) } : {}),
    expiresAt: Timestamp.fromDate(expiresAt),
    createdAt: Timestamp.now(),
    createdBy: process.env.USERNAME || process.env.USER || 'desconocido',
  });

  const durationText = premiumUntil
    ? `hasta ${premiumUntil.toISOString()}`
    : durationDays === 'lifetime'
      ? 'lifetime'
      : `${durationDays} dia(s)`;
  console.log(
    `Codigo ${code} creado: entitlement=${entitlementId}, cupo=${maxRedemptions}, duracion=${durationText}, vence=${expiresAt.toISOString()}${
      label ? `, etiqueta="${label}"` : ''
    }`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
