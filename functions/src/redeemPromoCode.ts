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

type ReservationResult =
  | { ok: true; durationDays: number }
  | { ok: false; error: RedeemError };

function normalizeCode(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}

/**
 * Canjea un código promocional y, si es válido, otorga el entitlement
 * rallystats_pro a la cuenta que llama por la cantidad de días que indique
 * el código (`durationDays`). Un mismo código no se puede canjear dos veces
 * desde la misma cuenta (subdocumento promo_codes/{code}/redemptions/{uid}).
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
      // Sólo cuenta como "ya usado" si quedó confirmado (redeemedAt seteado).
      // Un doc sin confirmar es un intento anterior que se cortó a mitad de
      // camino (RevenueCat falló y, por lo que sea, la reversión también) —
      // dejar reintentar en vez de bloquear a una cuenta que nunca recibió
      // el premium.
      if (redemptionSnap.exists && redemptionSnap.data()?.redeemedAt) {
        return { ok: false, error: 'already_used_by_account' };
      }

      const durationDays = data.durationDays as number;
      tx.update(codeRef, { redeemedCount: FieldValue.increment(1) });
      tx.set(redemptionRef, { redeemedAt: null, reservedAt: FieldValue.serverTimestamp() });
      return { ok: true, durationDays };
    });

    if (!reservation.ok) {
      logger.info('redeemPromoCode: rechazado', { uid, code, error: reservation.error });
      return { ok: false, error: reservation.error };
    }

    // 2) Recién ahora, fuera de la transacción, pegarle a RevenueCat.
    try {
      await grantPromotionalEntitlement(uid, revenueCatSecretKey.value(), reservation.durationDays);
    } catch (err) {
      // Si RevenueCat falla, liberar el cupo reservado para no "quemar" el
      // código en vano ni dejar a la cuenta bloqueada para reintentar. Esto
      // es "best effort": si esta reversión también falla (corte de red,
      // timeout de la function), el doc de redemptions queda sin
      // `redeemedAt`, así que el chequeo de arriba igual va a dejar
      // reintentar — sólo queda un poco de cupo "de más" gastado, en vez de
      // una cuenta bloqueada sin haber recibido nada.
      logger.error('redeemPromoCode: fallo RevenueCat, revirtiendo reserva', {
        uid,
        code,
        error: String(err),
      });
      try {
        await db.runTransaction(async (tx) => {
          tx.update(codeRef, { redeemedCount: FieldValue.increment(-1) });
          tx.delete(redemptionRef);
        });
      } catch (rollbackErr) {
        logger.error('redeemPromoCode: la reversion tambien fallo, revisar a mano', {
          uid,
          code,
          error: String(rollbackErr),
        });
      }
      throw new HttpsError('unavailable', 'No se pudo activar el premium, proba de nuevo');
    }

    // 3) Confirmar la redención recién ahora que RevenueCat ya otorgó el
    // entitlement — antes de esto, un reintento de la misma cuenta todavía
    // podía volver a pasar por acá (ver el chequeo de `redeemedAt` arriba).
    await redemptionRef.update({ redeemedAt: FieldValue.serverTimestamp() });

    logger.info('redeemPromoCode: canje exitoso', { uid, code });
    return { ok: true };
  },
);
