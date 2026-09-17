# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

Backend de **RallyStats** (la app Flutter de `volley_stats_app`, repo
separado): Firebase Cloud Functions (2nd gen) para canjear códigos
promocionales que otorgan 1 mes de RallyStats Premium sin depender de un
otorgamiento manual por dashboard de RevenueCat. Es la implementación de la
Fase 1 descrita en `RallyStats-Server-Side-Codigos-Federaciones.pdf`
(documento de diseño original — ahí está el razonamiento completo detrás de
cada decisión de este repo; acá sólo el resumen operativo).

Repo propio (`origin` → `github.com/ezecastiglione18/volley_stats_app_backend`),
pero **no es un proyecto independiente**: se despliega sobre el mismo
proyecto de Firebase que usa la app (`volleystatsapp-be835`), reutilizando su
Firebase Auth (mismo uid que loguea `AuthService` en la app) y su Firestore
(mismo proyecto que aloja `account_devices`). No hay build step de la app acá
ni viceversa — son dos repos, un solo proyecto de Firebase.

## Decisión de diseño: por qué Cloud Functions

Se comparó contra Cloudflare Workers y Node en Render/Fly — las tres cuestan
$0 a este volumen. Ganó Cloud Functions porque no suma proveedor ni sistema
de identidad nuevo (usa el Admin SDK para verificar el ID token de Firebase
automáticamente, en vez de reimplementarlo a mano) y guarda los códigos en el
mismo Firestore que ya existe. Ver PDF sección 1 para la comparativa completa
si hace falta reabrir esta decisión.

## Generalización respecto al PDF original

El PDF fue escrito pensando en códigos de federaciones (`federation_codes`,
`redeemFederationCode`), pero el pedido real es más simple y genérico: **un
código promocional cualquiera, canjeable una vez por cuenta, siempre por 1
mes de premium**. Este repo generalizó esa idea:

- Colección `promo_codes` en vez de `federation_codes` (sin campo
  `federation`, sí un `label` opcional libre para que el admin identifique
  el código).
- Function `redeemPromoCode` en vez de `redeemFederationCode`.
- Duración **fija en 1 mes calendario**, calculada en `revenuecat.ts` y
  mandada a RevenueCat como `end_time_ms` (no el campo `duration` del PDF,
  ver abajo) en vez del `durationBucket` configurable del PDF — no hace
  falta esa flexibilidad todavía. Si en el futuro hacen falta códigos de
  otra duración, sumar un campo al documento de Firestore y leerlo ahí en
  vez de asumir 1 mes a mano en otro lugar del código.

## Corrección respecto al PDF: RevenueCat no tiene modo sandbox para esto

Dos cosas que el PDF original asumía mal sobre RevenueCat (verificado contra
la documentación oficial y soporte de RevenueCat en septiembre 2026 — si
esto cambia en el futuro, revisar
https://www.revenuecat.com/docs/api-v1/entitlements antes de confiar en lo
de abajo):

1. **El campo `duration` del endpoint de otorgamiento promocional está
   deprecado** a favor de `end_time_ms` (timestamp explícito de
   vencimiento). `revenuecat.ts` ya usa `end_time_ms`, no `duration` como
   el pseudocódigo del PDF.
2. **Los otorgamientos promocionales no tienen concepto de sandbox**:
   siempre son reales, sin importar qué uid se use. Tampoco existe una
   Secret API Key separada "de prueba" — hay una sola por proyecto, la
   misma para `.secret.local` (emulador) y para
   `firebase functions:secrets:set` (producción). La seguridad de probar
   esto en sub-fase 1.4/1.5 del README depende enteramente de usar un uid
   descartable (nunca una cuenta real) y de revocar el entitlement de
   prueba después (`revokePromotionalEntitlement`) — no de ningún "modo
   sandbox" que no existe para este endpoint puntual.

El resto (transacción de Firestore para reservar cupo, reglas cerradas a
clientes, llamada a RevenueCat fuera de la transacción con rollback si
falla) sigue el pseudocódigo del PDF casi textual.

## Comandos

```bash
cd functions
npm install              # instalar dependencias
npm run build             # compilar TypeScript (tsc) a lib/
npm run build:watch        # compilar en watch mode
npm run serve                # build + levantar emuladores (auth, firestore, functions)
npm run shell                  # build + firebase functions:shell (invocar a mano)
npm run deploy                   # firebase deploy --only functions:redeemPromoCode
npm run logs                       # firebase functions:log
node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> [etiqueta]
```

No hay `flutter analyze`/tests automatizados en este repo — es sólo backend
TypeScript. `npm run build` (tsc en modo `strict`) es la única verificación
estática hoy; si se agrega lógica no trivial, considerar sumar
`firebase-functions-test` recién en ese momento, no antes.

## Arquitectura

**`functions/src/redeemPromoCode.ts`** es el corazón del repo: una Cloud
Function `onCall` (región `southamerica-east1`, igual que el resto de la
infraestructura pensada para Sudamérica) que hace, en este orden estricto:

1. Verifica `request.auth` (lo resuelve solo el SDK a partir del ID token de
   Firebase — no hay forma de canjear a nombre de otra cuenta).
2. Normaliza el código (`trim` + `toUpperCase`) para que no importe cómo lo
   tipee el usuario.
3. **Todo dentro de una transacción de Firestore**: valida existencia,
   vigencia (`expiresAt`) y cupo (`redeemedCount < maxRedemptions`) del
   código, valida que la cuenta no lo haya canjeado antes
   (`promo_codes/{code}/redemptions/{uid}`), y si todo está bien reserva el
   cupo (`increment(1)` + crear el subdocumento) atómicamente. Esto evita
   que dos canjes simultáneos del mismo código exploten el cupo.
4. **Recién fuera de la transacción**, llama a la API de RevenueCat
   (`grantPromotionalEntitlement` en `revenuecat.ts`) para otorgar el
   entitlement `rallystats_pro`. Si eso falla, revierte la reserva (otra
   transacción: decrementa el contador y borra el subdocumento) antes de
   lanzar el error — nunca deja un código "quemado" sin haber otorgado nada.

**`functions/src/firestore.ts`** centraliza `initializeApp()` +
`getFirestore()` para que no se llame dos veces (el Admin SDK explota si se
inicializa más de una vez); cualquier archivo nuevo que necesite Firestore
importa `db` de acá en vez de inicializar el suyo.

**`functions/src/revenuecat.ts`** es la única parte del código que sabe
hablar con la API HTTP de RevenueCat. Usa `fetch` global de Node (disponible
desde Node 18+, no hace falta `node-fetch`). `revokePromotionalEntitlement`
no la usa el flujo normal de `redeemPromoCode` (si RevenueCat falla, nunca
llegó a otorgar nada) — existe como herramienta manual para revertir
otorgamientos de prueba, algo necesario acá porque no hay modo sandbox (ver
sección de arriba): cada canje de prueba contra RevenueCat real queda
otorgado de verdad hasta que algo lo revoque (ver README, sub-fase 1.4).

**`functions/src/scripts/createPromoCode.ts`** es deliberadamente un script
aparte, no una Cloud Function HTTP: no hace falta exponer un endpoint de
administración para crear códigos a este volumen (ver PDF sección 9). Corre
local con el Admin SDK; contra qué Firestore pega depende pura y simplemente
de las credenciales activas en la terminal (`FIRESTORE_EMULATOR_HOST` para
el emulador, `GOOGLE_APPLICATION_CREDENTIALS`/ADC para producción) — el
script mismo no tiene ninguna lógica de entorno.

**`firestore.rules`** es del proyecto de Firebase entero, no de este repo
puntual — incluye tanto las reglas de `account_devices` (que en realidad le
pertenecen conceptualmente a `volley_stats_app`, pero hoy sólo existen
pegadas a mano en la consola, ver su `SETUP_FIREBASE.md`) como las de
`promo_codes` (cerradas del todo: `allow read, write: if false` — sólo el
Admin SDK, que ignora las reglas de seguridad, puede tocarlas). **Si algún
día cambian las reglas del lado de la app, hay que traer el cambio también
acá antes de volver a desplegar `firestore:rules` desde este repo, o se
pisan.**

## Convenciones

- TypeScript en modo `strict`; sin `any` salvo que sea imposible evitarlo.
- Mensajes de error hacia la app en `snake_case` (`invalid_code`, `expired`,
  `quota_exceeded`, `already_used_by_account`) — son el contrato con el lado
  Flutter (`_mapErrorCode` en el PDF, todavía no implementado del lado
  cliente). No cambiar estos strings sin actualizar ese mapeo cuando se
  escriba.
- Comentarios en español, igual que el resto del código de RallyStats.
- `logger.info`/`logger.error` de `firebase-functions/logger` en vez de
  `console.log` — quedan estructurados en Cloud Logging con severidad
  correcta.

## Estado actual / pendiente

- **Implementado**: `redeemPromoCode`, reglas de Firestore, script de
  generación de códigos. Compilado y verificado (`npm run build` sin
  errores) pero **todavía no desplegado ni probado contra el emulador** —
  seguir el plan de sub-fases del README antes de confiar en él contra
  producción.
- **No implementado a propósito** (ver README → Fase 2): nada del lado
  Flutter (`cloud_functions` en `pubspec.yaml`, `redeem_code_service.dart`,
  `RedeemCodeScreen`). Corresponde a otra versión de la app, después de que
  1.0.2 esté estable en Play Store.
- **No implementado, opcional** (PDF sección 7): Firebase App Check para que
  la function sólo acepte llamadas de la app real, y una alerta de tasa de
  error en Cloud Monitoring. Ninguno de los dos bloquea usar esto hoy.
- El plan Blaze y el secret `REVENUECAT_SECRET_KEY` de producción son pasos
  manuales de Eze/Tomi en las consolas de Firebase/RevenueCat — no hay nada
  que Claude Code pueda automatizar ahí.
