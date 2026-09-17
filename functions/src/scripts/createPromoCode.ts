/**
 * Script de administración: crea un documento en promo_codes. No se
 * despliega (no está exportado desde src/index.ts) — se corre a mano desde
 * esta máquina cada vez que hace falta un código nuevo.
 *
 * Apunta al emulador si FIRESTORE_EMULATOR_HOST está seteada (ver README,
 * sub-fase 1.3), o a producción si hay credenciales reales
 * (GOOGLE_APPLICATION_CREDENTIALS) — Admin SDK decide solo según el entorno.
 *
 * Uso: node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> [etiqueta]
 * Ejemplo: node lib/scripts/createPromoCode.js UNILIVO2026 50 2026-12-31 "Unilivo"
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

if (getApps().length === 0) {
  initializeApp();
}

async function main(): Promise<void> {
  const [rawCode, maxRedemptionsRaw, expiresAtRaw, label] = process.argv.slice(2);

  if (!rawCode || !maxRedemptionsRaw || !expiresAtRaw) {
    console.error('Uso: node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> [etiqueta]');
    process.exit(1);
  }

  const code = rawCode.trim().toUpperCase();
  const maxRedemptions = Number(maxRedemptionsRaw);
  if (!Number.isInteger(maxRedemptions) || maxRedemptions <= 0) {
    console.error('El cupo tiene que ser un entero positivo');
    process.exit(1);
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
    maxRedemptions,
    redeemedCount: 0,
    expiresAt: Timestamp.fromDate(expiresAt),
    createdAt: Timestamp.now(),
    createdBy: process.env.USERNAME || process.env.USER || 'desconocido',
  });

  console.log(
    `Codigo ${code} creado: cupo=${maxRedemptions}, vence=${expiresAt.toISOString()}${
      label ? `, etiqueta="${label}"` : ''
    }`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
