# volley_stats_app_backend

Backend de RallyStats: por ahora, una única Cloud Function (`redeemPromoCode`)
que permite canjear un código promocional para obtener **1 mes de RallyStats
Premium**, sin depender de un otorgamiento manual por cuenta desde el
dashboard de RevenueCat.

Repo separado del de la app ([volley_stats_app](https://github.com/ezecastiglione18/volley_stats_app)),
pero atado al **mismo proyecto de Firebase** (`volleystatsapp-be835`): reutiliza
la misma Auth y el mismo Firestore que ya usa la app para login y control de
dispositivos.

Para el contexto de diseño completo (por qué Cloud Functions y no otra
alternativa, modelo de datos, seguridad) ver el documento
`RallyStats-Server-Side-Codigos-Federaciones.pdf` que originó este proyecto.
`CLAUDE.md` tiene el resumen de las decisiones ya tomadas y las convenciones
del repo.

## Qué hay que tener instalado/configurado

1. **Node.js 22** (la runtime de la Cloud Function está fijada a esa versión
   en `functions/package.json` → `engines.node`; en esta máquina ya está
   instalado).
2. **Firebase CLI**: `npm install -g firebase-tools` (ya instalada en esta
   máquina, v15.28.1). Logueada con la cuenta de Google dueña del proyecto:
   `firebase login`.
3. **Plan Blaze activado** en el proyecto `volleystatsapp-be835` (Firebase
   Console → ⚙️ Configuración del proyecto → Uso y facturación → Modificar
   plan). Requiere tarjeta cargada, pero no cobra nada mientras el uso quede
   dentro de la franja gratis (2M invocaciones/mes) — igual conviene
   configurar una alerta de presupuesto en Google Cloud Billing (ej. avisar
   pasado 1 USD/mes) apenas se activa el plan.
4. **Dependencias del código**: `cd functions && npm install`.
5. **Secret de RevenueCat** (la *Secret API Key*, no la *Public API Key* que
   ya usa la app — se genera en RevenueCat → Project settings → API keys →
   "+ New secret API key"; asignarle sólo el permiso que necesita, otorgar/
   revocar entitlements promocionales de subscribers). Hay **una sola** key
   por proyecto, la misma para todo — RevenueCat no tiene una key separada
   de "sandbox" para esto (ver advertencia en la sub-fase 1.4 más abajo):
   - Para el emulador: archivo `functions/.secret.local` (gitignored, no se
     sube) con una línea `REVENUECAT_SECRET_KEY=<la secret key>`.
   - Para producción: `firebase functions:secrets:set REVENUECAT_SECRET_KEY`
     (pide pegar el mismo valor; queda en Google Secret Manager, nunca en el
     repo).
6. La cuenta con la que se corre `firebase deploy` necesita permisos de
   Editor/Owner (o los roles específicos de Cloud Functions Admin + Firebase
   Admin) sobre el proyecto de Google Cloud.

Nada de esto toca la app ni requiere una versión nueva de RallyStats — es
100% independiente del envío que está esperando revisión en Play Store.

## Estructura

```
firebase.json           # config de deploy + emuladores (Auth/Firestore/Functions)
.firebaserc              # proyecto por defecto: volleystatsapp-be835
firestore.rules           # reglas de TODO el proyecto (ver advertencia abajo)
firestore.indexes.json    # sin índices compuestos por ahora
functions/
  package.json
  tsconfig.json
  src/
    index.ts              # exporta las functions desplegables
    redeemPromoCode.ts     # la Cloud Function callable
    revenuecat.ts           # llamada HTTP a la API de RevenueCat
    firestore.ts             # instancia compartida del Admin SDK
    scripts/
      createPromoCode.ts      # script de administración (no se despliega)
```

### ⚠️ `firestore.rules` es del proyecto entero, no de este repo

Las reglas de seguridad de Firestore son un recurso único por proyecto de
Firebase, no algo que cada repo tenga "por su lado". Hoy incluyen tanto la
regla de `account_devices` (que usa la app, hasta ahora pegada a mano en la
consola — ver `SETUP_FIREBASE.md` en `volley_stats_app`) como la de
`promo_codes` (nueva, de este repo). Si en algún momento cambian las reglas
del lado de la app, hay que traer ese cambio también a este archivo *antes*
de correr `firebase deploy --only firestore:rules` — si no, se pisan y se
rompe el login.

## Modelo de datos en Firestore

```
promo_codes/{code}                  // ej: "UNILIVO2026"
  label: string | null              // referencia para el admin (opcional)
  maxRedemptions: number            // cupo total del código
  redeemedCount: number             // contador, se incrementa en la transacción
  expiresAt: timestamp              // el código deja de servir después de esta fecha
  createdAt: timestamp
  createdBy: string                 // usuario del SO que corrió el script

promo_codes/{code}/redemptions/{uid}
  redeemedAt: timestamp             // 1 doc por cuenta que ya canjeó ESTE código
```

Cerrado por completo a lectura/escritura de clientes (`firestore.rules`) —
sólo la Cloud Function, que corre con el Admin SDK, accede.

La duración del premium otorgado está **fija en 1 mes calendario**
(calculada en `revenuecat.ts`, mandada como `end_time_ms` a RevenueCat), a
propósito: es lo único que se necesita hoy. Si más adelante hacen falta
códigos de otra duración, hay que sumar un campo al documento (ej.
`durationMonths`) y leerlo en `redeemPromoCode.ts` en vez de asumir 1 mes.

## Generar un código

```bash
cd functions
npm run build
node lib/scripts/createPromoCode.js UNILIVO2026 50 2026-12-31 "Unilivo"
# Uso: createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> [etiqueta]
```

Contra qué Firestore pega depende de las credenciales activas en la terminal:
con `FIRESTORE_EMULATOR_HOST=localhost:8080` seteada apunta al emulador (ver
sub-fase 1.3 más abajo); sin esa variable, y con credenciales reales
(`GOOGLE_APPLICATION_CREDENTIALS` apuntando a una service account key, o
`gcloud auth application-default login` ya corrido), apunta a producción.

## Deploy a producción

```bash
firebase deploy --only functions:redeemPromoCode,firestore:rules
```

Cada deploy de una function 2nd gen crea una revisión nueva de Cloud Run por
debajo — si algo sale mal, se puede volver a la revisión anterior desde la
consola de Cloud Run sin reescribir código.

## Plan de implementación en sub-fases (Fase 1 del PDF)

El código de las cuatro sub-fases siguientes ya está escrito en este repo.
Lo que separa a cada sub-fase es **qué tan lejos se prueba antes de confiar
en la siguiente** — no conviene probar todo junto la primera vez.

### 1.1 — Cuenta y plan

- Activar plan Blaze + alerta de presupuesto (ver checklist arriba).
- `firebase login`, confirmar que ve el proyecto: `firebase projects:list`.

**Prueba:** `firebase projects:list` muestra `volleystatsapp-be835`, y
`cd functions && npm install && npm run build` compila sin errores.

### 1.2 — Reglas de Firestore

- Ya escritas en `firestore.rules` (unión de `account_devices` + `promo_codes`).

**Prueba:** `firebase emulators:start --only firestore` y, desde la pestaña
**Firestore** de la Emulator UI (`http://localhost:4000`), usar **Rules
playground**: simular una lectura/escritura de un cliente cualquiera sobre
`promo_codes/TEST` → tiene que dar **Denied**. Simular una escritura de un
usuario autenticado con su propio uid sobre `account_devices/{ese uid}` →
tiene que dar **Allowed** (para no haber roto el login sin querer).

### 1.3 — Lógica de canje contra el emulador (casos de rechazo)

Estos cuatro casos (`invalid_code`, `expired`, `quota_exceeded`,
`already_used_by_account`) se resuelven **antes** de llamar a RevenueCat, así
que se prueban sin necesitar ningún secret real.

```bash
firebase emulators:start --only auth,firestore,functions
```

1. Sembrar un código de prueba contra el emulador:
   ```bash
   FIRESTORE_EMULATOR_HOST=localhost:8080 node lib/scripts/createPromoCode.js TESTCODE 1 2020-01-01 "vencido a propósito"
   ```
2. Desde la Emulator UI → **Authentication**, crear un usuario de prueba y
   copiar su uid.
3. Invocar la function desde la pestaña de **Functions** de la Emulator UI
   (o con el SDK cliente apuntado al emulador) pasando `{ code: "TESTCODE" }`
   autenticado como ese usuario → tiene que devolver
   `{ ok: false, error: "expired" }` (la fecha de vencimiento quedó en el
   pasado a propósito).
4. Repetir sembrando un código con `maxRedemptions=0` → `quota_exceeded`; con
   un código inexistente → `invalid_code`; y canjeando dos veces seguidas un
   código válido con el mismo uid → la segunda tiene que dar
   `already_used_by_account`.

### 1.4 — Integración real con RevenueCat (uid descartable, no sandbox)

> ⚠️ **Corrección respecto al PDF original**: RevenueCat **no tiene un modo
> sandbox para otorgamientos promocionales** — "los otorgamientos
> promocionales no tienen concepto de sandbox o producción, siempre son de
> producción" (confirmado contra la documentación oficial y soporte de
> RevenueCat). Tampoco existe una Secret API Key "de prueba" separada: es la
> misma key para todo. Esto significa que **cualquier prueba de esta
> sub-fase otorga un entitlement real** en el proyecto real de RevenueCat —
> la única forma de que sea segura es usar siempre un **uid descartable**,
> nunca una cuenta de un usuario real, y revocarlo después.

1. `functions/.secret.local` con la Secret API Key real de RevenueCat (la
   única que existe).
2. Sembrar un código válido (cupo > 0, sin vencer) contra el emulador.
3. Desde la Emulator UI → **Authentication**, crear un usuario de prueba
   descartable (ej. `test-redeem@example.com`) y copiar su uid — no usar
   ninguna cuenta real, ni siquiera de prueba propia que uses para otra cosa.
4. Canjear el código autenticado como ese uid.
5. Confirmar en el dashboard de RevenueCat (proyecto real) que ese uid tiene
   ahora el entitlement `rallystats_pro` activo por 1 mes, y en la Emulator
   UI que `promo_codes/{CODIGO}` subió `redeemedCount` y que existe
   `promo_codes/{CODIGO}/redemptions/{uid}`.
6. **Limpiar**: revocar el entitlement de prueba con
   `POST /v1/subscribers/{uid}/entitlements/rallystats_pro/revoke_promotionals`
   (la función `revokePromotionalEntitlement` de `revenuecat.ts` hace
   exactamente esto — se puede invocar desde `firebase functions:shell` o un
   script suelto de una línea) para no dejar un entitlement de prueba
   colgado en el proyecto real.
7. **Probar el rollback**: cambiar momentáneamente `.secret.local` a un valor
   inválido, canjear otro código válido (con otro uid descartable) → tiene
   que fallar con `unavailable` y, revisando Firestore, `redeemedCount` NO
   debe quedar incrementado ni el subdocumento `redemptions/{uid}` debe
   existir (la transacción de reversa hizo su trabajo).

### 1.5 — Deploy a producción (todavía sin pantalla en la app)

1. `firebase functions:secrets:set REVENUECAT_SECRET_KEY` con la misma
   Secret Key de RevenueCat ya usada en 1.4 (no hay una "de producción"
   distinta).
2. `firebase deploy --only functions:redeemPromoCode,firestore:rules`.
3. Generar un código de prueba real (cupo bajo, ej. 1) con
   `node lib/scripts/createPromoCode.js`, esta vez sin
   `FIRESTORE_EMULATOR_HOST` (va contra el Firestore real).

**Prueba controlada, sin tocar cuentas reales de usuarios:** como todavía no
existe la pantalla "Tengo un código" en la app (eso es la Fase 2, client-side,
después de que 1.0.2 esté estable), para probar el flujo end-to-end contra la
function ya desplegada hace falta invocarla a mano con un ID token real. La
forma más simple: crear una cuenta descartable de prueba desde la propia app
(`Crear una cuenta`, con un email tipo `+test-canje@...`), loguearse, y desde
un script Node chico (usando `firebase-admin` para mintear un custom token
para ese uid y cambiarlo por un ID token, o pegando el ID token que loguea la
app en modo debug) invocar la function vía HTTPS callable. Confirmar en el
dashboard de RevenueCat que esa cuenta descartable recibió el entitlement,
revocarlo (paso 6 de la sub-fase 1.4) y borrar la cuenta desde la consola de
Firebase Auth para no dejar basura.

### 1.6 — Logs, monitoreo y hardening opcional

- Cada invocación ya queda en Cloud Logging (los `logger.info`/`logger.error`
  de `redeemPromoCode.ts` incluyen uid/código/resultado, para poder
  responder si alguien reclama que un código "no le funcionó").
- Sugerido, no implementado todavía: una alerta de tasa de error en Cloud
  Monitoring, y sumar Firebase App Check para que la function sólo acepte
  llamadas que vengan de la app real (ver PDF, sección 7).

## Fase 2 (pendiente, lado app)

No es parte de este repo. Cuando 1.0.2 esté estable en producción: sumar
`cloud_functions` al `pubspec.yaml` de `volley_stats_app`, el servicio
`redeem_code_service.dart` y la pantalla `RedeemCodeScreen` (pseudocódigo ya
armado en el PDF), y volver a pasar por revisión de Google Play como versión
nueva (ej. 1.0.3).

Mientras tanto, para cualquiera que necesite el premium antes de que la Fase
2 esté lista, el otorgamiento manual por dashboard de RevenueCat sigue
funcionando hoy mismo, sin depender de este backend ni de ninguna versión de
la app.
