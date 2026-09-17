# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

Backend de **RallyStats** (la app Flutter de `volley_stats_app`, repo
separado): Firebase Cloud Functions (2nd gen) para canjear códigos
promocionales que otorgan RallyStats Premium (por la cantidad de días que
indique cada código) sin depender de un otorgamiento manual por dashboard de
RevenueCat. Es la implementación de la
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
código promocional cualquiera, canjeable una vez por cuenta, por la cantidad
de días que indique ese código**. Este repo generalizó esa idea:

- Colección `promo_codes` en vez de `federation_codes` (sin campo
  `federation`, sí un `label` opcional libre para que el admin identifique
  el código).
- Function `redeemPromoCode` en vez de `redeemFederationCode`.
- Duración por código: campo `durationDays` (número de días, ej. 1 para un
  código de prueba, 30 para uno real) en vez del `durationBucket` del PDF
  (`'monthly' | 'weekly' | ...`, pensado en los buckets fijos de RevenueCat).
  Se manda a RevenueCat como `end_time_ms` (timestamp explícito), no como el
  campo `duration` del PDF — ver la corrección de abajo sobre por qué.

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
3. **Una Secret API Key "V2" (con permisos granulares) no sirve para el
   endpoint V1 que usa este código** — tira 403
   `"You're trying to use a secret API key incompatible with RevenueCat API
   V1"`. Pasó en la práctica: la primera key que se generó fue V2 por
   default, y sólo se notó al ver el error en `firebase functions:log`. Al
   crear la key en RevenueCat, el desplegable "API version" tiene que decir
   **V1** — ahí no aparece ninguna pantalla de permisos granulares, sólo
   pide un nombre. Si en algún momento se migra este código a la API v2 de
   RevenueCat (`https://api.revenuecat.com/v2/...`, distinta URL base y
   forma de pedir cosas), recién ahí una key V2 tendría sentido — hoy no.

El resto (transacción de Firestore para reservar cupo, reglas cerradas a
clientes, llamada a RevenueCat fuera de la transacción con rollback si
falla) sigue el pseudocódigo del PDF casi textual, con una diferencia real
encontrada probándolo: ver el punto 3-5 de "Arquitectura" más abajo sobre
por qué un doc de `redemptions/{uid}` no confirmado no bloquea un
reintento.

## Gotcha operativo: `firebase functions:secrets:set` no redespliega solo

Cada `firebase functions:secrets:set` crea una **versión nueva** del secret
en Secret Manager, pero una función ya deployada queda fijada a la versión
que existía en el momento de SU deploy (se ve literalmente como
`"version": "N"` en el `service_config` de la función, no como "latest").
Cambiar el valor del secret no alcanza para que la función lea el valor
nuevo. La CLI sí se da cuenta de este desfasaje: después de crear la versión
nueva, si detecta que alguna función quedó "using stale version of secret",
pregunta interactivamente si querés redeployarla ya mismo — decirle que sí
ahorra correr `firebase deploy` a mano después. Si se contesta que no (o se
corre el comando de forma no interactiva), la función sigue sirviendo con el
secret viejo hasta el próximo deploy explícito.

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
node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> <duracionDias> [etiqueta]
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
   código, valida que la cuenta no tenga ya un canje **confirmado**
   (`promo_codes/{code}/redemptions/{uid}` con `redeemedAt` seteado — un doc
   con `redeemedAt: null` es un intento anterior que no llegó a confirmarse,
   y no bloquea), y si todo está bien reserva el cupo (`increment(1)` +
   crear el subdocumento con `redeemedAt: null`) atómicamente. Esto evita que
   dos canjes simultáneos del mismo código exploten el cupo.
4. **Recién fuera de la transacción**, llama a la API de RevenueCat
   (`grantPromotionalEntitlement` en `revenuecat.ts`) para otorgar el
   entitlement `rallystats_pro`. Si eso falla, intenta revertir la reserva
   (otra transacción: decrementa el contador y borra el subdocumento) antes
   de lanzar el error — pero si **esa reversión también falla** (timeout,
   corte de red), no se queda una cuenta bloqueada sin haber recibido nada:
   como el doc de redemptions sigue sin `redeemedAt`, un reintento futuro
   igual va a poder pasar por acá. El único costo de ese caso raro es cupo
   de más gastado, nunca una cuenta trabada para siempre.
5. Si RevenueCat otorgó bien, recién ahí confirma
   (`redemptionRef.update({ redeemedAt: ... })`) — antes de esto, el intento
   todavía se consideraba "no confirmado" a los efectos del punto 3.

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

- **Deployado y funcionando en producción**: `redeemPromoCode` está activa
  en `southamerica-east1`, con el secret V1 de RevenueCat cargado, reglas de
  Firestore desplegadas, y probada de punta a punta con un código real
  (`PRUEBAPREMIUM`) desde un build real de la app — incluidos los casos de
  rechazo (código inválido/vencido/agotado/ya usado) y el flujo completo de
  éxito con el fix de caché del lado cliente (ver CLAUDE.md de
  `volley_stats_app`).
- **Implementado también del lado Flutter** (Fase 2, repo `volley_stats_app`):
  `cloud_functions` en el `pubspec.yaml`, `redeem_code_service.dart` y
  `RedeemCodeScreen` (en Configuración de la cuenta → "Tengo un código").
  Sigue sin publicarse en Play Store — existe y funciona en un build
  instalado por fuera, pendiente de sumarse a una versión nueva (ver README
  → Fase 2).
- **No implementado, opcional** (PDF sección 7): Firebase App Check para que
  la function sólo acepte llamadas de la app real, y una alerta de tasa de
  error en Cloud Monitoring. Ninguno de los dos bloquea usar esto hoy.
- El plan Blaze, la creación/rotación de la Secret API Key de RevenueCat (V1,
  no V2 — ver la corrección más arriba) y `firebase functions:secrets:set`/
  `firebase deploy` en producción son pasos manuales de Eze en las consolas
  de Firebase/RevenueCat/terminal — no hay nada de eso que Claude Code pueda
  automatizar (bloqueado a propósito por el modo automático: escrituras a
  secret store y deploys de producción quedan siempre para que los corra una
  persona).
