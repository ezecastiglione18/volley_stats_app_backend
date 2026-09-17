const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

/** Debe coincidir con `kPremiumEntitlementId` en subscription_tiers.dart (app). */
export const PREMIUM_ENTITLEMENT_ID = 'rallystats_pro';

/**
 * La duración la decide cada código (campo `durationDays` en
 * promo_codes/{code} — ver createPromoCode.ts), no está fija en el código:
 * un código de prueba puede otorgar 1 día, uno real para una federación
 * puede otorgar 30.
 *
 * Se manda como `end_time_ms` en vez del campo `duration` del endpoint: la
 * API de RevenueCat lo marca como deprecado a favor de `end_time_ms`
 * (timestamp explícito de vencimiento) — https://www.revenuecat.com/docs/api-v1/entitlements
 */
function daysFromNowMs(days: number): number {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

/**
 * Otorga el entitlement premium de forma promocional (gratis) vía la API de
 * RevenueCat, por `durationDays` días. IMPORTANTE: los otorgamientos
 * promocionales no tienen modo sandbox — esto siempre es un otorgamiento
 * real, sin importar qué uid se use ni con qué secret key (hay una sola, no
 * existe una "de prueba"). Para probar sin afectar a un usuario real hay que
 * usar un uid descartable, no una key distinta (ver README, sub-fase 1.4).
 */
export async function grantPromotionalEntitlement(
  uid: string,
  secretKey: string,
  durationDays: number,
): Promise<void> {
  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(uid)}/entitlements/${PREMIUM_ENTITLEMENT_ID}/promotional`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ end_time_ms: daysFromNowMs(durationDays) }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RevenueCat respondio ${res.status}: ${body}`);
  }
}

/**
 * Revierte un otorgamiento promocional. Se usa para pruebas manuales (dejar
 * limpia una cuenta descartable después de probar contra RevenueCat real) —
 * la función redeemPromoCode no la necesita en su flujo normal, porque si
 * RevenueCat falla directamente no llegó a otorgar nada.
 */
export async function revokePromotionalEntitlement(
  uid: string,
  secretKey: string,
): Promise<void> {
  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(uid)}/entitlements/${PREMIUM_ENTITLEMENT_ID}/revoke_promotionals`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`RevenueCat (revoke) respondio ${res.status}: ${body}`);
  }
}
