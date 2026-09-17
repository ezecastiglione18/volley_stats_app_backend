import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import * as logger from 'firebase-functions/logger';

import { db } from './firestore';
import { grantPromotionalEntitlement } from './revenuecat';

/** Secret API Key de RevenueCat (no la Public Key que usa la app). Se carga
 * con `firebase functions:secrets:set REVENUECAT_SECRET_KEY` en producción,
 * o en `functions/.secret.local` (gitignored) para el emulador. */
export const revenueCatSecretKey = defineSecret('REVENUECAT_SECRET_KEY');

type RedeemError =
  | 'invalid_code'
  | 'expired'
  | 'quota_exceeded'
  | 'already_used_by_account';

type ReservationResult = { ok: true } | { ok: false; error: RedeemError };

function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}

/**
 * Canjea un código promocional y, si es válido, otorga un mes de premium
 * (entitlement rallystats_pro) a la cuenta que llama. Un mismo código no se
 * puede canjear dos veces desde la misma cuenta (subdocumento
 * promo_codes/{code}/redemptions/{uid}).
 *
 * Devuelve { ok: true } o { ok: false, error } para los rechazos esperados
 * (código inválido/vencido/agotado/ya usado); sólo lanza HttpsError ante
 * fallas de sesión, argumentos, o si RevenueCat no responde.
 */
export const redeemPromoCode = onCall(
  { region: 'southamerica-east1', secrets: [revenueCatSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Hay que iniciar sesion');
    }
    const uid = request.auth.uid;
    const code = normalizeCode(request.data?.code);
    if (!code) {
      throw new HttpsError('invalid-argument', 'Falta el codigo');
    }

    const codeRef = db.collection('promo_codes').doc(code);
    const redemptionRef = codeRef.collection('redemptions').doc(uid);

    // 1) Validar y reservar el cupo dentro de una transacción, para que dos
    // canjes simultáneos del mismo código no pisen el conteo.
    const reservation = await db.runTransaction<ReservationResult>(async (tx) => {
      const codeSnap = await tx.get(codeRef);
      if (!codeSnap.exists) {
        return { ok: false, error: 'invalid_code' };
      }

      const data = codeSnap.data()!;
      const expiresAt = data.expiresAt as Timestamp | undefined;
      if (expiresAt && expiresAt.toMillis() < Date.now()) {
        return { ok: false, error: 'expired' };
      }

      const maxRedemptions = data.maxRedemptions as number;
      const redeemedCount = data.redeemedCount as number;
      if (redeemedCount >= maxRedemptions) {
        return { ok: false, error: 'quota_exceeded' };
      }

      const redemptionSnap = await tx.get(redemptionRef);
      if (redemptionSnap.exists) {
        return { ok: false, error: 'already_used_by_account' };
      }

      tx.update(codeRef, { redeemedCount: FieldValue.increment(1) });
      tx.set(redemptionRef, { redeemedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    });

    if (!reservation.ok) {
      logger.info('redeemPromoCode: rechazado', { uid, code, error: reservation.error });
      return { ok: false, error: reservation.error };
    }

    // 2) Recién ahora, fuera de la transacción, pegarle a RevenueCat.
    try {
      await grantPromotionalEntitlement(uid, revenueCatSecretKey.value());
    } catch (err) {
      // Si RevenueCat falla, liberar el cupo reservado para no "quemar" el
      // código en vano ni dejar a la cuenta bloqueada para reintentar.
      logger.error('redeemPromoCode: fallo RevenueCat, revirtiendo reserva', {
        uid,
        code,
        error: String(err),
      });
      await db.runTransaction(async (tx) => {
        tx.update(codeRef, { redeemedCount: FieldValue.increment(-1) });
        tx.delete(redemptionRef);
      });
      throw new HttpsError('unavailable', 'No se pudo activar el premium, proba de nuevo');
    }

    logger.info('redeemPromoCode: canje exitoso', { uid, code });
    return { ok: true };
  },
);
