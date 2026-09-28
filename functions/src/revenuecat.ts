const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

/** Debe coincidir con `kPremiumEntitlementId` en subscription_tiers.dart (app). */
export const PREMIUM_ENTITLEMENT_ID = 'rallystats_pro';

/**
 * Entitlements que un código promocional puede otorgar. Además del premium,
 * los de "dispositivo adicional": deben coincidir, en el mismo orden, con
 * `kDeviceAddOnEntitlementIds` en subscription_tiers.dart (app), que suma un
 * dispositivo por cada uno activo. Tienen que existir creados en el
 * dashboard de RevenueCat (Entitlements) con estos mismos identificadores.
 */
export const PROMO_ENTITLEMENT_IDS = [
  PREMIUM_ENTITLEMENT_ID,
  'device_addon_1',
  'device_addon_2',
  'device_addon_3',
] as const;

/**
 * Duración de un otorgamiento: cantidad de días, o `'lifetime'` (sin
 * vencimiento, lo mismo que la opción "Lifetime" del dashboard).
 */
export type PromoDuration = number | 'lifetime';

/**
 * La duración la decide cada código (campo `durationDays` en
 * promo_codes/{code} — ver createPromoCode.ts), no está fija en el código:
 * un código de prueba puede otorgar 1 día, uno real para una federación
 * puede otorgar 30.
 *
 * Una duración en días se manda como `end_time_ms` en vez del campo
 * `duration` del endpoint: la API de RevenueCat lo marca como deprecado a
 * favor de `end_time_ms` (timestamp explícito de vencimiento) —
 * https://www.revenuecat.com/docs/api-v1/entitlements. La excepción es
 * `'lifetime'`: `end_time_ms` no tiene forma de expresar "sin vencimiento",
 * y `duration: 'lifetime'` sigue siendo un valor documentado (verificado en
 * septiembre 2026).
 */
function grantBody(duration: PromoDuration): Record<string, unknown> {
  if (duration === 'lifetime') return { duration: 'lifetime' };
  return { end_time_ms: Date.now() + duration * 24 * 60 * 60 * 1000 };
}

/**
 * Otorga `entitlementId` de forma promocional (gratis) vía la API de
 * RevenueCat, por `duration`. IMPORTANTE: los otorgamientos
 * promocionales no tienen modo sandbox — esto siempre es un otorgamiento
 * real, sin importar qué uid se use ni con qué secret key (hay una sola, no
 * existe una "de prueba"). Para probar sin afectar a un usuario real hay que
 * usar un uid descartable, no una key distinta (ver README, sub-fase 1.4).
 */
export async function grantPromotionalEntitlement(
  uid: string,
  secretKey: string,
  entitlementId: string,
  duration: PromoDuration,
): Promise<void> {
  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(uid)}/entitlements/${encodeURIComponent(entitlementId)}/promotional`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(grantBody(duration)),
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
  entitlementId: string = PREMIUM_ENTITLEMENT_ID,
): Promise<void> {
  const res = await fetch(
    `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(uid)}/entitlements/${encodeURIComponent(entitlementId)}/revoke_promotionals`,
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
