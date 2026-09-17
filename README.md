# volley_stats_app_backend

Backend de RallyStats: por ahora, una única Cloud Function (`redeemPromoCode`)
que permite canjear un código promocional para obtener **RallyStats
Premium por la cantidad de días que indique ese código**, sin depender de un
otorgamiento manual por cuenta desde el dashboard de RevenueCat.

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

Este repo lo tocan dos personas — Eze (dueño de las cuentas) y Fede (ayudando
con el código) — y no las dos necesitan lo mismo. Lo de abajo separa qué hace
falta para simplemente **compilar y probar en local** (cualquiera de los
dos, en su propia máquina) de lo que sólo puede hacer **quien tiene acceso a
las cuentas reales** (Firebase, RevenueCat, Google Cloud Billing — hoy, Eze).

### Para compilar y probar en local (Eze o Fede, cada uno en su máquina)

1. **Node.js 22** (la runtime de la Cloud Function está fijada a esa versión
   en `functions/package.json` → `engines.node`).
2. **Firebase CLI**: `npm install -g firebase-tools`, logueada con **la
   cuenta de Google que cada uno use habitualmente** —
   `firebase login`. No hace falta que sea la cuenta dueña del proyecto para
   esto: loguearse y correr el emulador no requiere ningún permiso especial
   sobre `volleystatsapp-be835`.
3. Clonar el repo y `cd functions && npm install`.
4. Con eso ya alcanza para compilar (`npm run build`), levantar el emulador
   completo (`npm run serve`) y probar toda la lógica de rechazo del canje
   (sub-fase 1.3 más abajo) — nada de eso toca el proyecto real de Firebase
   ni RevenueCat.

### Sólo con las cuentas reales (hoy: Eze)

1. **Plan Blaze activado** en el proyecto `volleystatsapp-be835` (Firebase
   Console → ⚙️ Configuración del proyecto → Uso y facturación → Modificar
   plan). Requiere tarjeta cargada, pero no cobra nada mientras el uso quede
   dentro de la franja gratis (2M invocaciones/mes) — igual conviene
   configurar una alerta de presupuesto en Google Cloud Billing (ej. avisar
   pasado 1 USD/mes) apenas se activa el plan. Sólo lo puede hacer quien es
   Owner/Editor del proyecto.
2. **Acceso al dashboard de RevenueCat** para generar/rotar la *Secret API
   Key* (la que pega en Project settings → API keys → "+ New secret API
   key" — no la *Public API Key* que ya usa la app). RevenueCat no tiene una
   key separada de "sandbox" para esto (ver advertencia en la sub-fase 1.4
   más abajo) — **pero sí importa el "API version" del desplegable al
   crearla**: elegir **V1**, no V2. El código usa el endpoint V1 de
   RevenueCat (`/v1/subscribers/.../entitlements/.../promotional`), y una
   key V2 (con permisos granulares) le da 403 "incompatible with RevenueCat
   API V1" — no hay forma de que una key V2 sirva acá, hay que generarla
   como V1 directamente (sin pantalla de permisos granulares, sólo un
   nombre).
3. **La secret key en sí**, cargada en `functions/.secret.local` (para el
   emulador, gitignored) o vía `firebase functions:secrets:set
   REVENUECAT_SECRET_KEY` (para producción, queda en Google Secret Manager).
4. **Deploy real** (`firebase deploy`) y `firebase functions:secrets:set`
   contra producción requieren permisos de Editor/Owner (o los roles
   puntuales Cloud Functions Admin + Firebase Admin) sobre el proyecto de
   Google Cloud.

### Si Fede necesita ir más allá del emulador

No hace falta para nada de las sub-fases 1.1 a 1.3 (100% local). Si en algún
momento hace falta que también corra las sub-fases 1.4/1.5 (que sí pegan
contra RevenueCat/Firestore reales) o deploye él mismo, son dos decisiones
que le corresponden a Eze, no algo que se resuelva solo:

- **Sumarlo como miembro del proyecto de Firebase**: Firebase Console → ⚙️
  Configuración del proyecto → Usuarios y permisos → Agregar miembro (su
  email de Google), rol Editor (o los roles puntuales de arriba). Así puede
  hacer `firebase login` con su propia cuenta y ya tiene permiso para
  `deploy`/`secrets:set`, sin compartir la cuenta de Eze.
- **Compartirle la secret key de RevenueCat** (para que la pegue en su
  propio `.secret.local`, nunca por chat/mensajería sin cifrar) — es una key
  sensible, puede otorgar o revocar premium en cualquier cuenta, así que
  conviene pensarlo antes de repartirla.

Nada de esto toca la app ni requiere una versión nueva de RallyStats — es
100% independiente del envío que está esperando revisión en Play Store.

## Comandos importantes

Todos corren desde `functions/` salvo que se indique lo contrario.

```bash
# --- Setup / compilación ---
npm install                    # instalar dependencias (primera vez, o si cambió package.json)
npm run build                   # compilar TypeScript -> lib/ (hace falta antes de correr scripts o el emulador a mano)
npm run build:watch              # compilar en watch mode mientras se edita

# --- Desarrollo local (emulador) ---
npm run serve                      # build + levanta Auth/Firestore/Functions emulados
# Emulator UI (con el emulador arriba levantado): http://localhost:4000
npm run shell                        # build + consola interactiva para invocar functions a mano

# --- Generar un código promocional ---
node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> <duracionDias> [etiqueta]
# contra el emulador: anteponer FIRESTORE_EMULATOR_HOST=localhost:8080
# sin esa variable, y con credenciales reales: va contra producción

# --- Cuenta / proyecto ---
firebase login                         # loguear la CLI con una cuenta de Google
firebase projects:list                   # confirmar que se ve volleystatsapp-be835
firebase use                               # ver/confirmar a qué proyecto apunta esta carpeta

# --- Secret de RevenueCat (sólo quien tenga la key real) ---
firebase functions:secrets:set REVENUECAT_SECRET_KEY   # cargarla en producción (Secret Manager)

# --- Deploy a producción ---
npm run deploy                                   # equivale a: firebase deploy --only functions:redeemPromoCode
firebase deploy --only functions:redeemPromoCode,firestore:rules   # ídem + reglas de Firestore (usar este si tocaste firestore.rules)

# --- Logs ---
npm run logs                                       # equivale a: firebase functions:log
```

⚠️ `npm run deploy` **no** incluye `firestore:rules` — si el cambio tocó
`firestore.rules`, usar el comando completo con la coma, si no las reglas
nuevas quedan sin desplegar aunque la function sí se actualice.

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
  durationDays: number              // cuántos días de premium otorga ESTE código (ej. 1, 30)
  expiresAt: timestamp              // el código deja de servir después de esta fecha
  createdAt: timestamp
  createdBy: string                 // usuario del SO que corrió el script

promo_codes/{code}/redemptions/{uid}
  reservedAt: timestamp             // se crea al reservar el cupo, antes de llamar a RevenueCat
  redeemedAt: timestamp | null      // null hasta que RevenueCat confirma; recién ahí "ya usado" de verdad
```

Cerrado por completo a lectura/escritura de clientes (`firestore.rules`) —
sólo la Cloud Function, que corre con el Admin SDK, accede.

El doc de `redemptions/{uid}` pasa por dos estados a propósito: se crea con
`redeemedAt: null` al reservar el cupo, y recién se confirma (`redeemedAt`
con la fecha real) después de que RevenueCat otorgó el entitlement. Sólo un
doc **confirmado** bloquea un reintento (`already_used_by_account`) — uno
sin confirmar es un intento anterior que se cortó a mitad de camino (falló
RevenueCat, o hasta la propia reversión), y no debe dejar a una cuenta
bloqueada sin haber recibido nada.

La duración la decide **cada código** (`durationDays`), no es fija: un
código de prueba puede otorgar 1 día, uno real para una federación puede
otorgar 30. `revenuecat.ts` calcula la fecha de vencimiento a partir de ese
número y la manda a RevenueCat como `end_time_ms`.

## Generar un código

Comando y ejemplo en "Comandos importantes" arriba. Contra qué Firestore
pega depende de las credenciales activas en la terminal: con
`FIRESTORE_EMULATOR_HOST=localhost:8080` seteada apunta al emulador (ver
sub-fase 1.3 más abajo); sin esa variable, y con credenciales reales
(`GOOGLE_APPLICATION_CREDENTIALS` apuntando a una service account key, o
`gcloud auth application-default login` ya corrido), apunta a producción.

## Deploy a producción

Comando en "Comandos importantes" arriba. Cada deploy de una function 2nd
gen crea una revisión nueva de Cloud Run por debajo — si algo sale mal, se
puede volver a la revisión anterior desde la consola de Cloud Run sin
reescribir código.

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
   FIRESTORE_EMULATOR_HOST=localhost:8080 node lib/scripts/createPromoCode.js TESTCODE 1 2020-01-01 30 "vencido a propósito"
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
   ahora el entitlement `rallystats_pro` activo por la cantidad de días del
   código sembrado, y en la Emulator
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

### 1.5 — Deploy a producción

**Ya se hizo** (función activa en `southamerica-east1`, secret V1 cargado,
probado de punta a punta con un código real desde la app). Para repetirlo
después de un cambio de código, o si hay que rotar el secret:

1. `firebase functions:secrets:set REVENUECAT_SECRET_KEY` — sólo hace falta
   si cambió el *valor* de la key (ojo: tiene que ser una key **V1**, ver
   checklist de arriba). Si la función ya estaba deployada usando una
   versión anterior del secret, la CLI detecta que "1 function is using
   stale version of secret" y **ofrece redeployarla sola** — decirle que sí
   ahorra el paso 2 siguiente.
2. `firebase deploy --only functions:redeemPromoCode,firestore:rules` —
   hace falta sí o sí después de cualquier cambio en el *código* (el paso 1
   sólo redespliega automáticamente si lo que cambió fue el secret).
3. Generar un código real con `node lib/scripts/createPromoCode.js` (sin
   `FIRESTORE_EMULATOR_HOST`, va contra producción) — si no hay credenciales
   de administrador a mano en la máquina desde la que se corre esto (no hay
   `gcloud` ni una service account key configurada), es más rápido crear el
   documento a mano en Firebase Console → Firestore Database, con los
   mismos campos de "Modelo de datos" más arriba.

**Prueba end-to-end**: ya no hace falta invocar la función a mano con un ID
token — la pantalla "Tengo un código" del lado cliente (Fase 2, ver
`volley_stats_app`) ya está implementada. Alcanza con instalar un build de
la app (`flutter build apk --release`), loguearse, y canjear el código desde
Configuración de la cuenta → Tengo un código. Usar una cuenta descartable la
primera vez que se prueba un código nuevo, para no gastar el cupo de un
código real por error.

### 1.6 — Logs, monitoreo y hardening opcional

- Cada invocación ya queda en Cloud Logging (los `logger.info`/`logger.error`
  de `redeemPromoCode.ts` incluyen uid/código/resultado, para poder
  responder si alguien reclama que un código "no le funcionó").
- Sugerido, no implementado todavía: una alerta de tasa de error en Cloud
  Monitoring, y sumar Firebase App Check para que la function sólo acepte
  llamadas que vengan de la app real (ver PDF, sección 7).

## Fase 2 (lado app — implementada, todavía no publicada)

No es parte de este repo, vive en `volley_stats_app`: `cloud_functions` en
el `pubspec.yaml`, `lib/services/redeem_code_service.dart` y la pantalla
`lib/screens/subscription/redeem_code_screen.dart` (accesible desde
Configuración de la cuenta → "Tengo un código"). Ya está escrita y probada
de punta a punta contra este backend real (build instalado por fuera de
Play Store) — lo único que falta es que salga en una versión publicada:
seguir el proceso de release ya documentado en el `CLAUDE.md` de ese repo
(regenerar el manual si corresponde, `flutter analyze`, APK, AAB) y subirla
como versión nueva (ej. 1.0.3), pasando de nuevo por revisión de Google
Play. Ver el `CLAUDE.md` de `volley_stats_app` para los dos detalles no
obvios del lado cliente (región de la function, invalidar el caché de
RevenueCat después del canje).

Mientras tanto, para cualquiera que necesite el premium antes de que esa
versión nueva esté publicada, el otorgamiento manual por dashboard de
RevenueCat sigue funcionando igual, sin depender de esto.
