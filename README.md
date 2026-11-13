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

> **Desde el 13/11/2026 hay una segunda función, `submitFeedback`** (formulario "Reportar un error o
> consultar" de la app, sección 26): guarda el reporte en Firestore y lo manda por mail. Ver "Reportes de
> error" más abajo. El resto de este README sigue hablando del canje de códigos.

## Estado actual (al 2 de noviembre de 2026)

| Punto | Estado |
|---|---|
| 1.1 Cuenta y plan | ✅ Hecho. Blaze activo; presupuesto mensual de USD 1 con alertas al 50, 90 y 100 %. |
| 1.2 Reglas de Firestore | ✅ Desplegadas el 26/10/2026 (incluyen `matches`, `teams`, `plays` y `fixture` del sync de la app); coinciden con `firestore.rules`. |
| 1.3 Lógica de rechazo en emulador | ✅ Hecho. Además hay pruebas del límite de intentos (ver 1.6). |
| 1.4 Integración real con RevenueCat | ✅ Hecho. |
| 1.5 Deploy a producción | ✅ Hecho. Última versión desplegada el 2/11/2026 (con `maxInstances: 10` y límite de intentos). Canje real de prueba con un código `--random`: funcionó. |
| 1.6 Logs, monitoreo y hardening | 🟡 Parcial. Hecho: `maxInstances`, límite de intentos, backups, protección contra borrado, alerta de errores 5xx. Pendiente: App Check, alerta por picos de `invalid_code`, probar una restauración de backup, runbook. |
| Fase 2 (lado app) | ✅ Implementada y probada contra este backend. La publicación en Play se sigue en el repo de la app. |
| `submitFeedback` (13/11/2026) | 🟡 Escrita y probada con el emulador (9 tests); **sin desplegar**. Falta: cargar los dos secretos de Gmail, desplegar función y reglas, crear la política TTL y la prueba manual (ver "Reportes de error"). |

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
node lib/scripts/createPromoCode.js <CODIGO> <cupo> <YYYY-MM-DD> <duracionDias|lifetime|fecha> [etiqueta] [--entitlement=<id>] [--until=<YYYY-MM-DD>]
# sin --entitlement otorga premium (rallystats_pro); para un dispositivo adicional: --entitlement=device_addon_1 (o _2, _3)
# la <YYYY-MM-DD> de la 3ª posición es hasta cuándo se puede CANJEAR; con --until=<YYYY-MM-DD> el otorgamiento
# termina en esa fecha fija (inclusive) para todos, y la duración va como la palabra "fecha"
# contra el emulador: anteponer FIRESTORE_EMULATOR_HOST=localhost:8080
# sin esa variable, y con credenciales reales: va contra producción

# --- Generar un código aleatorio (recomendado para códigos reales) ---
node lib/scripts/createPromoCode.js --random <cupo> <YYYY-MM-DD> <duracionDias|lifetime|fecha> [etiqueta] [--entitlement=<id>] [--until=<YYYY-MM-DD>]
# ídem npm run create-code -- --random ...
# con --random NO se pasa el código: lo genera el script (12 caracteres de ABCDEFGHJKLMNPQRSTUVWXYZ23456789,
# sin I/O/0/1, con crypto.randomInt) y lo imprime al terminar. Los argumentos que siguen son los mismos de arriba, sin <CODIGO>.

# --- Cuenta / proyecto ---
firebase login                         # loguear la CLI con una cuenta de Google
firebase projects:list                   # confirmar que se ve volleystatsapp-be835
firebase use                               # ver/confirmar a qué proyecto apunta esta carpeta

# --- Secret de RevenueCat (sólo quien tenga la key real) ---
firebase functions:secrets:set REVENUECAT_SECRET_KEY   # cargarla en producción (Secret Manager)

# --- Tests (emulador de Firestore; ver "Reportes de error → Tests") ---
npm test                                           # build + node:test de submitFeedback contra el emulador

# --- Secretos de Gmail (submitFeedback; sólo quien tenga la cuenta real) ---
firebase functions:secrets:set GMAIL_USER              # la cuenta de Gmail que manda los mails
firebase functions:secrets:set GMAIL_APP_PASSWORD      # su contraseña de aplicación (16 letras, sin espacios)

# --- Deploy a producción ---
npm run deploy                                   # equivale a: firebase deploy --only functions:redeemPromoCode,functions:submitFeedback
firebase deploy --only functions:redeemPromoCode,functions:submitFeedback,firestore:rules   # ídem + reglas de Firestore (usar este si tocaste firestore.rules)

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
    submitFeedback.ts      # reportes de error / consultas (sección 26)
    revenuecat.ts           # llamada HTTP a la API de RevenueCat
    firestore.ts             # instancia compartida del Admin SDK
    scripts/
      createPromoCode.ts      # script de administración (no se despliega)
  test/
    submitFeedback.test.js    # pruebas con el emulador de Firestore (no se despliegan)
  .env                       # FEEDBACK_TO (parámetro no secreto de submitFeedback)
```

### ⚠️ `firestore.rules` es del proyecto entero, no de este repo

Las reglas de seguridad de Firestore son un recurso único por proyecto de
Firebase, no algo que cada repo tenga "por su lado". Hoy incluyen tanto la
regla de `account_devices` (que usa la app, hasta ahora pegada a mano en la
consola — ver `SETUP_FIREBASE.md` en `volley_stats_app`) como la de
`promo_codes` (nueva, de este repo), las del sync de la app (`matches`,
`teams`, `plays`, `fixture`) y, desde el 13/11/2026, `feedback` y
`feedback_attempts` (cerradas a los clientes, **sin desplegar todavía**).
Antes de desplegar, comparar este archivo con las reglas publicadas en la
consola: el 26/10 coincidían. Si en algún momento cambian las reglas
del lado de la app, hay que traer ese cambio también a este archivo *antes*
de correr `firebase deploy --only firestore:rules` — si no, se pisan y se
rompe el login.

## Modelo de datos en Firestore

```
promo_codes/{code}                  // ej: "UNILIVO2026"
  label: string | null              // referencia para el admin (opcional)
  maxRedemptions: number            // cupo total del código
  redeemedCount: number             // contador, se incrementa en la transacción
  entitlementId: string             // qué otorga: rallystats_pro (default si falta) o device_addon_1/2/3
  durationDays: number | 'lifetime' | null // cuántos días otorga ESTE código (ej. 1, 30), o sin vencimiento; null si usa premiumUntil
  premiumUntil: timestamp           // (opcional) fecha fija de fin del otorgamiento; si está, manda sobre durationDays
  expiresAt: timestamp              // el código deja de servir (de CANJEAR) después de esta fecha
  createdAt: timestamp
  createdBy: string                 // usuario del SO que corrió el script

promo_codes/{code}/redemptions/{uid}
  reservedAt: timestamp             // se crea al reservar el cupo, antes de llamar a RevenueCat
  redeemedAt: timestamp | null      // null hasta que RevenueCat confirma; recién ahí "ya usado" de verdad
```

```
promo_attempts/{uid}                // límite de intentos por cuenta (ver 1.6)
  count: number                     // intentos consumidos en la ventana actual
  windowStart: number               // inicio de la ventana (ms desde epoch); dura 1 hora
```

```
feedback/{autoId}                   // reportes de error / consultas (submitFeedback, sección 26)
  uid: string                       // cuenta que lo mandó (lo toma la función de la sesión)
  name: string | null               // opcional, hasta 80 caracteres
  contactEmail: string | null       // opcional, formato válido; es a quien se le responde
  comment: string                   // 10 a 2000 caracteres
  diagnostics: map                  // appVersion, platform, osVersion, plan (free/premium/desconocido),
                                    //   cloudEnabled (bool | null), locale. NUNCA el mail de la cuenta
  createdAt: timestamp              // serverTimestamp
  expireAt: timestamp               // createdAt + 12 meses: lo borra la política TTL de Firestore
  status: 'pending' | 'sent' | 'failed'   // pending al guardar; sent/failed según el mail

feedback_attempts/{uid}             // límite de envíos por cuenta: 5 por hora
  count: number
  windowStart: number               // ms desde epoch; la ventana dura 1 hora
```

Todo lo de arriba está cerrado por completo a lectura/escritura de clientes
(`firestore.rules`; `promo_attempts` no tiene regla, así que queda denegada; `feedback` y
`feedback_attempts` tienen su `match` con `allow read, write: if false`)
— sólo la Cloud Function, que corre con el Admin SDK, accede.

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
número y la manda a RevenueCat como `end_time_ms`; con `'lifetime'` manda
`duration: 'lifetime'` (lo mismo que la opción "Lifetime" del dashboard).

Si el código trae `premiumUntil`, se manda ese timestamp fijo como
`end_time_ms` en vez de `ahora + durationDays`: todos terminan el mismo día
sin importar cuándo canjeen. Si esa fecha ya pasó al momento de canjear, se
rechaza como `expired`. Es opcional — los códigos anteriores no lo tienen y
siguen funcionando igual.

Lo que otorga también lo decide cada código (`entitlementId`): premium, o
uno de los tres complementos de "dispositivo adicional" (`device_addon_1`,
`_2`, `_3`), que la app suma al límite de dispositivos igual que si se
hubieran comprado (ver `deviceLimitFrom` en `subscription_tiers.dart` de
la app). Esos entitlements tienen que existir creados en el dashboard de
RevenueCat con esos identificadores exactos.

## Generar un código

Comando y ejemplo en "Comandos importantes" arriba. Para códigos reales
conviene `--random`: un código con palabra + año (tipo `UNILIVO2026`) se
puede adivinar, uno de 12 caracteres aleatorios (32^12 ≈ 2^60 combinaciones)
no. Los códigos ya emitidos con el formato viejo siguen funcionando igual.
Contra qué Firestore
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

## Reportes de error (`submitFeedback`, sección 26)

Función `onCall` de `southamerica-east1` (`maxInstances: 10`) que recibe lo que la app manda desde
Configuración → "Reportar un error o consultar". Va en `functions/src/submitFeedback.ts`; la lógica está en
`processFeedback` (con el envío del mail inyectable, para poder probarla sin SMTP) y el `onCall` solo la conecta
con Gmail. Orden, pensado para que **un reporte nunca se pierda**:

1. Sin sesión → `unauthenticated`. El `uid` sale de la sesión; la app no lo manda.
2. Valida lo mismo que la app (comentario 10-2000 sin contar espacios de los bordes, nombre ≤ 80, mail opcional
   con formato válido y ≤ 254); los campos desconocidos se ignoran y el diagnóstico se sanea (lista cerrada de
   claves, topes de largo, sin caracteres de control: lo que va al asunto del mail no puede partir un
   encabezado). Datos inválidos → `invalid-argument`, **sin gastar un envío**.
3. Límite: 5 por hora y cuenta en `feedback_attempts/{uid}`, mismo patrón que `promo_attempts` (transacción,
   fail-open si el contador falla). El sexto → `resource-exhausted`. A diferencia del canje, un envío exitoso **no**
   reinicia el contador; solo se devuelve el intento si no se pudo guardar el reporte.
4. Guarda `feedback/{autoId}` con `status: "pending"`. Si esto falla → `internal` (la app conserva el texto).
5. Recién ahí intenta el mail (nodemailer, SMTP de Gmail, timeouts de 15 s). Para: `FEEDBACK_TO`; asunto
   `[RallyStats] Reporte · v{versión} · {plataforma}`; cuerpo en texto plano con nombre, mail, comentario,
   diagnóstico y uid; `replyTo` solo si el usuario dejó un mail.
6. Marca `sent` o `failed` (con el error en los logs: `firebase functions:log`, buscar "fallo el envio del mail")
   y devuelve `{ ok: true }` **aunque el mail falle**, porque el reporte quedó guardado.

**Configuración.** `FEEDBACK_TO` es un parámetro no secreto (`defineString`) y vive en `functions/.env`
(`FEEDBACK_TO=...`; se cambia con un deploy, sin publicar otra versión de la app; la dirección ya figura en la
política de privacidad). `GMAIL_USER` y `GMAIL_APP_PASSWORD` son secretos (`defineSecret`): en producción con
`firebase functions:secrets:set` (Secret Manager) y, para el emulador, en `functions/.secret.local`. Hace falta una
cuenta de Gmail con **verificación en dos pasos** y una **contraseña de aplicación** (Cuenta de Google → Seguridad →
Contraseñas de aplicaciones; se pega sin los espacios). Alternativa descartada por ahora: un servicio como Resend.
Igual que con RevenueCat, `secrets:set` no redespliega solo: después de cambiar un secreto hay que desplegar (o
contestar que sí cuando la CLI lo ofrece).

**Retención de 12 meses.** Cada reporte lleva `expireAt`. Falta crear **una vez** la política TTL de Firestore que
lo usa (no se despliega con `firebase deploy`):

```bash
gcloud firestore fields ttls update expireAt --collection-group=feedback --enable-ttl --project=volleystatsapp-be835
```

(o Firebase Console → Firestore → TTL → crear política, colección `feedback`, campo `expireAt`). El borrado es
automático pero no instantáneo (suele tardar hasta un día). Los reportes **no** se borran al eliminar la cuenta
(las reglas los cierran a la app): se piden por mail (ver el borrador de política del repo de la app).

**Tests.** `npm test` compila y corre `functions/test/submitFeedback.test.js` (`node:test`) contra el emulador de
Firestore (`firebase emulators:exec`), con el envío del mail simulado: sin sesión se rechaza; los datos inválidos se
rechazan y no gastan envíos; límites exactos (10/2000, 80); el sexto envío de la hora se rechaza y la ventana se
reinicia pasada la hora; con el mail simulado el documento pasa a `sent` (y lleva `replyTo` solo si hay mail); si el
mail tira error queda `failed` y la función devuelve ok; sin `FEEDBACK_TO` también queda `failed`. El emulador
necesita **Java 21 o más**: el del sistema es 17, pero el JBR de Android Studio (`D:\Android\jbr`) sirve:
`JAVA_HOME=D:\Android\jbr PATH=$JAVA_HOME/bin:$PATH npm test`.

**Prueba manual** (después de desplegar): ver la lista al final de la sesión del 13/11/2026 en `PROXIMOS_PASOS.md`.

## Plan de implementación en sub-fases (Fase 1 del PDF)

El código de las cuatro sub-fases siguientes ya está escrito en este repo.
Lo que separa a cada sub-fase es **qué tan lejos se prueba antes de confiar
en la siguiente** — no conviene probar todo junto la primera vez.

### 1.1 — Cuenta y plan

**Estado: ✅ hecho.** Blaze activo; presupuesto de USD 1/mes con alertas al
50, 90 y 100 %.

- Activar plan Blaze + alerta de presupuesto (ver checklist arriba).
- `firebase login`, confirmar que ve el proyecto: `firebase projects:list`.

**Prueba:** `firebase projects:list` muestra `volleystatsapp-be835`, y
`cd functions && npm install && npm run build` compila sin errores.

### 1.2 — Reglas de Firestore

**Estado: ✅ desplegadas el 26/10/2026**, con `plays` y `fixture` incluidos;
las publicadas en la consola coinciden con `firestore.rules`.

- Ya escritas en `firestore.rules` (unión de `account_devices` + `promo_codes`, más
  los datos de sync de la app: `matches`, `teams`, `plays` y `fixture`, todos
  accesibles sólo por su dueño).

**Prueba:** `firebase emulators:start --only firestore` y, desde la pestaña
**Firestore** de la Emulator UI (`http://localhost:4000`), usar **Rules
playground**: simular una lectura/escritura de un cliente cualquiera sobre
`promo_codes/TEST` → tiene que dar **Denied**. Simular una escritura de un
usuario autenticado con su propio uid sobre `account_devices/{ese uid}` →
tiene que dar **Allowed** (para no haber roto el login sin querer).

### 1.3 — Lógica de canje contra el emulador (casos de rechazo)

**Estado: ✅ hecho.**

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

**Estado: ✅ hecho.**

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

**Estado: ✅ hecho.** Función activa en `southamerica-east1`, secret V1
cargado, probado de punta a punta con un código real desde la app. Última
versión desplegada el 2/11/2026 (`maxInstances: 10` + límite de intentos); ese
día se confirmó un canje real con un código generado con `--random`. Para repetirlo
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
**Estado: 🟡 parcial (al 2/11/2026).**

Hecho:

- **Tope de instancias:** `maxInstances: 10` en `redeemPromoCode`, para acotar
  el gasto si alguien le pega en masa.
- **Límite de intentos:** 10 por hora y por cuenta, contados en
  `promo_attempts/{uid}` con una transacción. Se consume un intento **antes**
  de validar el código (aunque el código sea válido, el intento número 11 de
  la hora se rechaza con `resource-exhausted`, sin gastar cupo). Un canje
  exitoso reinicia el contador, y si falla RevenueCat (`unavailable`) el
  intento se devuelve. Si el propio contador falla (error de Firestore), la
  función sigue sin límite en vez de bloquear canjes legítimos, y lo deja en
  el log. La app ya trata cualquier error desconocido como error genérico, así
  que no hizo falta tocarla. Límite conocido: es por cuenta, y registrarse es
  libre; no frena a quien use muchas cuentas.
- **Backups de Firestore:** diarios, con retención de 7 días; protección
  contra borrado de la base activada. PITR desactivada a propósito. La base
  `(default)` está en `nam5` (Estados Unidos) y esa ubicación no se puede
  cambiar.
- **Alerta de errores:** política de Cloud Monitoring «RallyStats - errores en
  canje de códigos» sobre errores 5xx de `redeempromocode` (ventana de 5
  minutos). Los rechazos normales (`invalid_code`, 429) no la disparan.
- Cada invocación queda en Cloud Logging (los `logger.info`/`logger.error` de
  `redeemPromoCode.ts` incluyen uid/código/resultado, para poder responder si
  alguien reclama que un código "no le funcionó").

Pendiente:

- **Firebase App Check** para que la function sólo acepte llamadas de la app
  real (requiere cambio en la app y una versión nueva; ver PDF, sección 7).
- Alerta por picos de `invalid_code` / `resource-exhausted`.
- Probar una restauración de backup al menos una vez y escribir un runbook de
  incidentes.

## Fase 2 (lado app — implementada)

**Estado: ✅ implementada y probada contra este backend real.** En qué versión
publicada de Play sale se sigue en el repo de la app.

No es parte de este repo, vive en `volley_stats_app`: `cloud_functions` en
el `pubspec.yaml`, `lib/services/redeem_code_service.dart` y la pantalla
`lib/screens/subscription/redeem_code_screen.dart` (accesible desde
Configuración de la cuenta → "Tengo un código"). Ya está escrita y probada
de punta a punta contra este backend real. Para publicarla, seguir el
proceso de release ya documentado en el `CLAUDE.md` de ese repo (regenerar
el manual si corresponde, `flutter analyze`, APK, AAB) y subirla como versión
nueva, pasando por revisión de Google Play. Ver el `CLAUDE.md` de
`volley_stats_app` para los dos detalles no obvios del lado cliente (región
de la function, invalidar el caché de RevenueCat después del canje).

Para cualquiera que no tenga todavía una versión con "Tengo un código", el
otorgamiento manual por dashboard de RevenueCat sigue funcionando igual, sin
depender de esto.
