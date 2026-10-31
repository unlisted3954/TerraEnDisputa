# Referencia técnica de Terra en disputa v1

Este documento describe el funcionamiento actual. No es una lista de instrucciones para agentes ni una restricción para futuros cambios visuales o de arquitectura. El servidor implementa las reglas y valida cada acción.

## Organización

Monorepo TypeScript, con Node.js `>=24.11.0 <25` y pnpm `10.15.0`:

| Ubicación                  | Responsabilidad                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/game-engine/src` | Datos de Classic, preparación, reglas, acciones legales e invariantes; motor de Reconquista en `reconquista/`. Transiciones de estado sin HTTP, UI ni almacenamiento. |
| `packages/protocol/src`    | Mensajes y esquemas Zod compartidos entre cliente y servidor.                                                                                                         |
| `apps/server/src`          | Fastify, HTTP/WebSocket, autenticación, proyecciones, coordinación de partidas y persistencia; rutas y guardado de Reconquista en `reconquista/`.                     |
| `apps/server/assets`       | Catálogo y arte del tablero de Reconquista que lee el servidor.                                                                                                       |
| `apps/web/src`             | React/Vite, mapa SVG, paneles, interacción y reconexión.                                                                                                              |
| `scripts`                  | Compilación, verificación del paquete, actualización e instalación.                                                                                                   |

Un proceso aloja varias partidas independientes y sirve tanto la web como la API. No requiere una base de datos externa. El servidor genera las tiradas y los barajados; la animación de dados no determina el resultado. Las conexiones entre países pertenecen a los datos del motor, no a la posición de las líneas dibujadas.

## Modalidades

Classic es la modalidad predeterminada, para 2–6 humanos. Competitivo admite 4–6 humanos: preparación 4+4 y máximo acumulado de cuatro tropas adicionales por jugador y continente. Modalidad y contadores iniciales se persisten; la modalidad queda fijada al crear la partida. Con cuatro no hay pactos ni objetivos de destrucción, igual que en la mesa de seis con `competitiveBotSeats: 2` (cuatro personas y dos bots `bot: 'table'` que el servidor agrega en el arranque, sin sesión, con 80 minutos fijos; `humanSeats` da los asientos para personas); con cinco/seis solo hay pactos de frontera, uno por pareja de jugadores (incluida una ruptura en espera y una propuesta pendiente), con aceptación inmediata, vencimiento al cierre completo del turno receptor y rupturas asimétricas con espera de dos incorporaciones del destinatario. Un rechazo queda en `competitiveRejections` y bloquea al proponente cinco minutos de tiempo efectivo frente a ese destinatario. Atacar desde el único país propio con cuatro ejércitos o menos se rechaza (`SUICIDE_ATTACK`). Desde la penúltima ronda, el comando `request_bot` deja a quien tiene un solo país con `bot: 'requested'` (`canRequestCompetitiveBot`, proyectado como `botRequestAvailable`). `botPlayed` recuerda que un bot jugó el asiento y las filas de resultados lo exponen como `bot: 'table' | 'replacement'`. Con `competitiveDeciding` (elegido en la sala, incompatible con `competitiveBotSeats`) no hay bots: el asiento que vence desconectado queda `inactive`, con pactos cancelados, y sus activaciones duran `INACTIVE_TURN_MS` (60 s) sin pausa por desconexión. El administrador lo cambia con `POST /api/admin/games/:id/players/:playerId/inactive` (`markCompetitiveInactive`), que acorta a un minuto la activación en curso. `pnpm simulate:bots` (después de `pnpm build`; `--games N` por mesa, `--seed S`, `--mode classic` para Clásico, que juega cada mesa en Express y sin límite, de dos a seis jugadores, cuenta los pactos propuestos, aceptados, rechazados y rotos, y da por trabada una partida sin límite que pasa de 300 rondas o que se queda sin jugada posible, y distingue las segundas) juega partidas solo con bots, sin servidor, con un segundo de juego por jugada, en mesas mixtas, de a pares y de un solo nivel; informa victorias por dificultad frente a lo esperado por azar, cómo terminan (misión, 30 países o tiempo, con el desempate como ganador), duración y partidas trabadas, y sale con error si alguna se traba. El motor mide tiempo efectivo (60 minutos con cuatro; 80 con cinco/seis, o 60 si `competitiveDurationMinutes` elige Express en la sala) para anunciar dos rondas finales adicionales, con turnos de dos minutos y tres en finales. Los empates se definen por países, ejércitos, canjes y cartas, y después se reparten los puntos; la eliminación que cumple el objetivo de destrucción del ganador no suma +10. Los resultados finales para el administrador incluyen clasificación, puntos exactos y exportación JSON/CSV; se derivan del tablero final, cartas contadas, canjes y el historial durable de eliminaciones. No se envían a las proyecciones de jugadores. El indicador público de elegibilidad sí refleja la puntuación oficial, incluyendo historial incompleto o herencia pendiente; el indicador persistido de etapa 3 conserva el requisito de seis rondas como dato histórico. Sin historial completo o seis rondas completas no hay puntuación oficial.

Reconquista admite 2–6 humanos, con su propio tablero de 72 países, situaciones, misiles, alianzas y condominios. Se elige en el mismo selector del anfitrión y usa las mismas rutas, sesión de administrador, carpeta de datos y copias de seguridad, con motor y guardado propios: ver [Reconquista](#reconquista).

## Partidas, sesiones y asientos

- El administrador crea, configura, inicia y elimina partidas. Para comenzar deben estar ocupados todos los asientos y todos los jugadores deben estar listos. No puede jugar en nombre de otra persona ni alterar sus recursos u objetivos.
- Administrar y jugar son identidades separadas: el anfitrión se incorpora como cualquier otro jugador. El enlace compartido identifica una partida, no autentica a un jugador existente.
- El ciclo es `LOBBY → SETUP → ACTIVE → FINISHED`. Tras comenzar no se vuelve al lobby; cantidad de jugadores, colores, nombres e identidades quedan fijados. La rotación de iniciativa sigue las reglas de Classic.
- Cada inicio normal del servidor genera un código administrativo nuevo e invalida el anterior y la sesión administrativa previa. El código se imprime en la terminal, no se almacena en texto claro ni se publica por HTTP. Backup y restauración no lo rotan por sí solos.
- El acceso automático del anfitrión utiliza un token local de lanzamiento, de un solo uso y con vencimiento de cinco minutos. No se habilita con `--no-open`, origen público o proxy confiable. El código manual sigue disponible.
- Los jugadores reciben una cookie de sesión HttpOnly, vinculada al transporte HTTP/HTTPS, con vigencia de 30 días. Refrescar, desconectarse, cerrar el navegador o reiniciar el servidor conserva el asiento. Perder la cookie puede dejarlo inaccesible: no hay recuperación de códigos ni reasignación administrativa.
- Solo **Salir de la partida**, autenticado y confirmado, libera el asiento. En el lobby lo elimina y libera color y número; después de comenzar conserva identidad, territorios, ejércitos, cartas, objetivo, pactos y acciones pendientes, pero revoca el controlador y sus conexiones.
- Quien tenga el enlace puede ocupar un asiento explícitamente liberado e heredar su estado e información privada. La confirmación de salida lo advierte. La lista pública no expone cartas, objetivos ni credenciales. Dos intentos simultáneos no pueden ocupar el mismo asiento; las credenciales anteriores no controlan al reemplazo. No hay salto automático de turno.

## Autoridad y comunicación

HTTP gestiona acceso, lobby y administración; WebSocket transmite comandos y estados de una partida. Los contratos exactos están en `packages/protocol/src/index.ts` y las rutas en `apps/server/src/app.ts`. La versión de protocolo actual es **13**; un cliente incompatible necesita actualizarse.

La entrada pública usa `GET /api/games/:gameId/entry`; ocupar un asiento liberado usa `POST /api/games/:gameId/take-seat` con `playerId`; salir usa `POST /api/games/:gameId/leave` para el jugador autenticado, sin elegir otro jugador.

Cada comando de juego lleva `commandId`, `baseRevision` y una intención, no un estado completo que el cliente pueda imponer. El servidor:

1. Valida el mensaje y la sesión vigente de esa partida.
2. Reconoce comandos ya confirmados antes de rechazar una revisión antigua. El mismo ID con otro contenido se rechaza.
3. Comprueba revisión, jugador, turno, fase, propiedad, cantidades y reglas.
4. Calcula el resultado y guarda estado y deduplicación juntos.
5. Solo después del commit confirma y distribuye las proyecciones nuevas.

Las mutaciones se serializan por partida, incluyendo cambios de asientos. Dos pestañas no otorgan dos turnos: tras el primer commit, la segunda solicitud nueva queda obsoleta. Se conservan los últimos 256 comandos; fuera de esa ventana, la revisión antigua impide repetir la acción. Las pistas de acciones legales del frontend no sustituyen ninguna validación del servidor.

## Privacidad y frontend

Cada jugador recibe el tablero público, los recuentos públicos y únicamente sus propias cartas y objetivo. El administrador no recibe los secretos de los jugadores. Terminar la partida no revela automáticamente las manos u objetivos de los perdedores; el objetivo del ganador se revela cuando corresponde al motivo de victoria registrado.

El cliente separa el estado recibido del servidor de selecciones, paneles, sonidos y animaciones. Seleccionar un país no ejecuta una acción. Una actualización invalida selecciones que ya no son legales; el resultado estratégico no se inventa de manera optimista. Transferencias de conquista y otras decisiones pendientes sobreviven a reconexiones y reinicios.

Al reconectar se obtiene un snapshot actual, no un historial de mensajes perdidos. Se ignoran estados antiguos. Si se perdió la respuesta de una acción, el reintento conserva su ID, revisión y contenido originales para reconciliarla sin ejecutarla dos veces. La presencia y los latidos de WebSocket son efímeros, no turnos nuevos.

## Almacenamiento y compatibilidad

`apps/server/src/persistence` guarda snapshots JSON versionados con estado completo, autenticación, revisiones y deduplicación. Incluye fases, acciones pendientes, orden de jugadores y contadores para continuar sin repetir reparto, tiradas o premios. Un bloqueo permite que un solo proceso posea la carpeta de datos.

Las versiones actuales son snapshot de partida **12**, autenticación **1** y backup **3** (el 3 agrega las partidas de Reconquista). Son independientes del protocolo. Se valida el contenido antes de cargarlo; formatos futuros se rechazan y una partida corrupta se aísla sin reiniciarla como si fuera nueva. Las partidas sanas pueden seguir disponibles.

El esquema 12 agrega la identidad de edición `definition` (ver más abajo) y admite partidas de los esquemas 5 a 11, a las que asigna Classic. También asigna explícitamente la modalidad Classic y migra las incorporaciones históricas 5/3 a índices 1/2 sin cambiar tablero, jugador activo ni saldo. El esquema 7 conserva la modalidad y los acuerdos existentes; las rupturas ya anunciadas conservan su espera histórica simétrica. Las nuevas rupturas competitivas guardan términos, participantes, autor y saldo de una o dos incorporaciones en `competitiveWithdrawals`; la proyección pública permite mostrar quién está libre y quién sigue restringido. Las propuestas vencen solo al cierre completo del turno de hostilidades del destinatario. El esquema 9 añade `competitiveClock`, descalificación y `pendingInheritance`, preserva guardados anteriores y rechaza campos nuevos etiquetados con versiones antiguas. El arranque pausa las mesas competitivas en curso y conserva saldos; las mesas antiguas sin reloj reciben dos minutos y cero tiempo general histórico. Rondas completas se derivan del índice normal. El esquema 10 agrega `competitiveHistory`: víctima, responsable y turno en secuencia de confirmación, con indicador de completitud. No inventa eventos históricos; una partida antigua con eliminados sin registro muestra resultado incompleto y cero puntos oficiales. El resumen administrativo calculado lleva versión de reglas 1 y conserva fracciones exactas en JSON/CSV. Escribe el formato nuevo al siguiente commit. Mantiene identidades y verificadores históricos: los asientos antiguos protegidos por recuperación o reasignación no se convierten automáticamente en públicos. El nombre persistido `controllerless_reassignment` se conserva por compatibilidad; solo un registro sin sesión ni credenciales de recuperación/reclamo permite tomar el asiento sin código. Los endpoints históricos ya no están disponibles. También se conservan los objetivos de destrucción heredados según las reglas de compatibilidad de Classic.

Los archivos usan generaciones y reemplazos atómicos, con recuperación adaptada a la plataforma:

- `COMMITTED`: el resultado puede hacerse autoritativo y enviarse al cliente.
- `FAILED`: no se confirma el candidato ni se continúa jugando sin guardar.
- `INDETERMINATE`: se bloquean las mutaciones de esa partida y se preservan los archivos; la recuperación al reiniciar determina qué generación completa sobrevivió.

Estas garantías dependen del sistema operativo y filesystem, no cubren cualquier fallo de hardware. Los backups y restores son operaciones offline/exclusivas, validadas y completas. Restaurar conserva la generación anterior. No hay limpieza automática de partidas finalizadas ni de backups; un downgrade tras migrar puede necesitar un backup compatible. No se editan a mano los JSON ni se mezclan generaciones parciales. Comandos y rutas: [SELF_HOSTING.md](SELF_HOSTING.md#copias-restauración-y-actualización).

## Relojes y herencia de Competitivo

`packages/game-engine/src/competitive-clock.ts` administra tiempo efectivo, saldo de activación, pausa y espera técnica con tiempo/RNG inyectables. Preparación no consume el tiempo general. El vencimiento completa únicamente movimientos obligatorios ya pendientes, distribuye refuerzos legalmente, pierde oportunidades de carta y cierra la activación. Refuerzos sin destino legal por zonas internacionales se pierden sin terminar pactos. No inventa canjes ni ataques. La selección de refuerzo se comunica por comando validado y persiste; no renueva el saldo.

`GameService` serializa tick, comando y pausa mediante el mismo coordinador y revisión CAS. Un límite de tiempo o cambio de actor invalida comandos tardíos con `STALE_REVISION`; commits fallidos no se difunden. El scheduler del servidor confirma checkpoints normalmente cada segundo y emite estados públicos/privados. Los saldos administrativos pausados no se consumen. El endpoint autenticado de administrador `POST /api/admin/games/:gameId/pause` recibe `{ paused: boolean }`, valida Origin y exige conexiones disponibles para reanudar. No hay comando de jugador para pausar, alterar el reloj ni anunciar cierre.

Desconexión del actor: cinco minutos de gracia por activación sin consumo de juego/turno (`technicalRemainingMs`); después corre el tiempo del turno. Si la activación vence sin reconexión, el asiento pasa a `bot: 'absent'` (o a `absent` si `competitiveBotsReplaceAbsent` es `false`): se cancelan sus pactos, propuestas, rupturas y rechazos. Con `absent`, sus activaciones vencen enseguida con refuerzos al azar; con `bot`, el servidor juega una jugada por tick (`chooseBotCommand` en `competitive-bot.ts`, nivel `competitiveBotLevel`, por defecto `hard`: `easy` elige al azar entre jugadas razonables con el `ShuffleSource` que recibe, `normal` usa reglas fijas de ventaja y `hard` valora cada país según misión, objetivo común y continentes, ataca según `conquestChance` y en las dos últimas rondas solo con alta probabilidad) sin pausa por desconexión. Ambos se quitan cuando vuelve a estar conectado. `bot: 'admin'` lo pone y quita el administrador (`POST /api/admin/games/:id/players/:playerId/bot`) y no se quita al reconectar; nivel y reemplazo se cambian con `PATCH /api/admin/games/:id/bots`. Los comandos de un asiento con bot se rechazan con `BOT_CONTROLLED` y nadie puede formar pactos con un bot ni con un ausente. Conserva puesto y puntos. `technicalRemainingByPlayer` y `disqualified` se mantienen solo para guardados anteriores. En apagado normal se confirma el saldo antes de cerrar conexiones; al arrancar se conserva y requiere reanudación administrativa. Tras caída abrupta se congela el último checkpoint confirmado; no se inventa el tramo no confirmado ni se descuenta tiempo apagado. Guardados sin reloj anterior arrancan pausados con saldo nuevo, sin tiempo histórico inventado.

Clásico Express (`classicExpress: true`, solo en Classic, elegido en la sala con `PATCH` de configuración) usa el mismo reloj: `hasGameClock` lo habilita para Competitivo y Express, y `gameClockDurationMs` da 40 minutos con dos o tres jugadores y la duración de Competitivo con más. Al vencer el tiempo y las dos rondas finales, `timeLimitWinner` elige al ganador por países, ejércitos, canjes y cartas; un empate completo termina sin `winnerId`. No hay `scoringEligible`, tope de cuatro por continente en la preparación ni cancelación de pactos por ausencia. Si una incorporación vence con más de cinco cartas, se aplica el primer canje legal antes de repartir los refuerzos, porque Classic lo exige. `chooseBotCommand` también juega Classic, con o sin Express: coloca los ejércitos de la preparación de dos y tres jugadores, no aplica el tope por continente y deja que las acciones legales le impongan los pactos vigentes y el canje obligatorio; En Classic el servidor juega los asientos con `bot` igual que en Competitivo, una jugada por tick, y antes deja que un bot responda la propuesta que lo espera. Con Express, el asiento vencido pasa a `bot: 'absent'` salvo que `competitiveBotsReplaceAbsent` sea `false`; sin Express no hay ausentes y solo el administrador pone o quita bots (`bot: 'admin'`), y la partida entra al scheduler mientras tenga un bot. En Classic los pactos del jugador reemplazado se mantienen y no hay `request_bot`. `competitiveBotSeats` admite en Classic de 1 a `configuredPlayerCount - 1` bots `bot: 'table'`, elegidos en la sala (`0` los quita; si no se envía, se conservan); el servidor los agrega al comenzar, también con dos o tres jugadores. Con Express, quitar un bot de la mesa deja el asiento `absent` y `controllerless_reassignment`, con el registro abierto para que una persona lo tome; sin Express no se puede quitar. En Classic los bots pactan: `chooseBotCommand` primero responde la propuesta que espera al bot, aunque no sea su turno (acepta si quien propone tiene más ejércitos o si el pacto cuida un continente que tiene; rechaza zonas internacionales y a su objetivo de destrucción; Fácil decide al azar). En su ataque, Difícil anuncia la ruptura del primer pacto que le estorba (compañero objetivo de destrucción o con menos de la mitad de sus ejércitos, o un país vecino que su misión necesita, o cualquiera a cinco países o menos del objetivo común) y, si no, propone un pacto de frontera a un vecino más fuerte que amenaza un continente que tiene o al que le falta un país, uno por turno (`botProposalTurn`, que guarda `applyBotCommand`) y sin otra propuesta suya pendiente. En las rondas finales de Classic Express se pueden seguir rompiendo pactos.

Las cartas del eliminado dejan de pertenecerle inmediatamente: se transfieren hasta cinco, o quedan en `pendingInheritance` si hay elección parcial. Las opciones se proyectan solo al conquistador; selección dentro del saldo, RNG ante ausencia/vencimiento, excedente al descarte. Identidad de las 50 cartas incluye cartas pendientes. Classic conserva herencia completa y canje obligatorio por mano superior a cinco; Competitivo admite canje voluntario futuro y bloquea nuevas cartas mientras tiene cinco o más. Una victoria inmediata puede dejar la elección de herencia dentro del saldo restante; no posterga la victoria.

Cierre por tiempo: termina ronda actual y dos completas adicionales, sin ganador inventado (`time_limit`). Si todos los jugadores quedan eliminados/descalificados, registra `no_competitors`. Objetivos siguen produciendo victoria inmediata. `scoringEligible` informa si se completaron seis rondas normales; la clasificación y los puntos se calculan al finalizar y se presentan en los resultados administrativos. La primera hostilidad aislada y las dos incorporaciones iniciales no cuentan para ese mínimo.

## Seguridad y despliegue

Las sesiones aleatorias se verifican mediante hashes; los códigos administrativos mediante scrypt con salt. Las credenciales no van en enlaces de partida ni proyecciones públicas. Los logs ordinarios no incluyen manos, objetivos o tokens; el código de arranque es la excepción deliberada en la terminal del operador.

HTTP/WebSocket validan Origin, esquemas, tamaños y permisos; hay límites de solicitudes y gestión de conexiones revocadas. Los pedidos con sesión válida cuentan por asiento (o anfitrión); los demás, incluidas cookies que no corresponden a nadie, por dirección, y una red IPv6 /64 cuenta como una sola. Cada tipo de pedido tiene contadores propios, separados para pedidos con y sin sesión, así que una inundación sin sesión no frena a quienes ya juegan ni a otras partidas. Cada cookie de anfitrión se compara con el ingreso guardado, que espera en la misma fila que los guardados de partidas: antes de leerlo, el pedido cuenta contra su dirección (30 por segundo) y solo las cookies que fallan quedan contadas, así que el anfitrión real nunca suma. El ingreso del anfitrión no tiene tope global: tras seis intentos fallidos, cada fallo de una dirección duplica su espera (1, 2, 4… segundos, hasta un minuto), y las demás direcciones no esperan. El acceso a archivos y procesos del servidor pertenece al operador confiable, no ofrece aislamiento frente al administrador del sistema operativo.

Riesgos aceptados, revisados y sin cambio:

- En Linux, `ted` sin servicio abre el navegador con el token de lanzamiento en los argumentos de `xdg-open`, que otro usuario de la misma PC puede leer en `/proc`. El token es de un solo uso y el navegador lo canjea en milisegundos; pasarlo por un archivo temporal falla con navegadores Snap y Flatpak. La app de escritorio y el servicio systemd no lo usan.
- El servicio deja el código de administrador en el journal, donde el operador lo busca. Solo lo leen root y los grupos `adm` y `systemd-journal`, que ya controlan el equipo.
- El servidor no consulta versiones nuevas por su cuenta. El panel del anfitrión muestra la versión instalada con un enlace a la página de versiones.
- Por HTTP en la red local, quien comparta la red puede ver el tráfico. Cada página servida por HTTP lo avisa en una franja arriba.

HTTP es para redes de confianza o VPN privadas. En Internet se utiliza HTTPS con un proxy que soporte WebSocket, `GAME_PUBLIC_ORIGIN` exacto y `GAME_TRUSTED_PROXY` limitado al proxy real. Las cabeceras reenviadas de fuentes no confiables se ignoran. Firewall, DNS, certificados y VPN se configuran fuera de Terra en disputa.

## Compilación y distribución

Los paquetes portables Linux x64 y Windows x64 incluyen Node, servidor, web, licencia y avisos de terceros. No requieren Node instalado para ejecutarse. `scripts/release-build.mjs` genera el archivo, manifest y checksums; `scripts/release-smoke.mjs` comprueba contenido, arranque, persistencia y backup con datos descartables.

Uso del servidor: [SELF_HOSTING.md](SELF_HOSTING.md). Compilar/actualizar: [UPDATING.md](UPDATING.md). Servicio Linux: [INSTALLING.md](INSTALLING.md). Licencia y procedencia: [LICENSING_IP.md](LICENSING_IP.md).

## Zonas internacionales

Classic permite proponer zonas internacionales sin umbral de canjes ni rondas y anunciarlas en retiro voluntario durante su hostilidad. Las obligaciones siguen hasta que todos los demás supervivientes completen una hostilidad; incorporación y rotación no acortan la espera, y un traslado pendiente no cancela el acuerdo aunque deje cero ejércitos temporales. Competitivo permite propuestas desde la ronda 3 y conserva su ruptura unilateral, con espera de dos incorporaciones del destinatario y prohibición desde el anuncio final.

## Comandos y checkpoints del reloj

`GameService` reconoce en memoria intervalos contiguos de revisiones cuyo único cambio son las mediciones del reloj. Una intención puede utilizar una revisión de ese intervalo, con autorización vigente y revalidación temporal. Las modificaciones restantes invalidan el intervalo; no se persiste ni se reconstruye después de un reinicio. Las revisiones futuras y las anteriores a cambios reales siguen rechazadas. No cambia el formato de persistencia ni el protocolo.

La espera técnica restante persiste en `technicalRemainingMs` también tras reconectar y se reinicia únicamente al cambiar de activación. Los mensajes WebSocket tienen límites por jugador/partida/servidor de 30/120/600 por segundo, con hasta ocho mensajes en proceso por conexión y ocho conexiones simultáneas por jugador y partida. Los rechazos sin transición no generan difusión global; los límites por jugador abarcan todas sus conexiones de esa partida.

## Nombre y operación

El nombre del juego es **Terra en disputa** (TED); la modalidad se presenta como **Terra en disputa — Competitivo**. Los controles compactos usan TED. Los ejecutables son `ted` y `ted.cmd`, el paquete raíz es `ted` y las distribuciones usan `ted-<versión>-<plataforma>`. La instalación predeterminada es `~/ted`, con la unidad `ted.service`; consultá la [guía de instalación](INSTALLING.md).

- Datos Linux: `$XDG_DATA_HOME/ted` o `~/.local/share/ted`; Windows: `%LOCALAPPDATA%/TED/data`. `--data-dir` permite una ubicación explícita.
- Cookies `ted_*_session_http` y `__Host-ted_*_session_https`, con HttpOnly, SameSite=Strict y Secure en HTTPS. Las sesiones están separadas por transporte, autoridad y partida.
- Persistencia: formatos `ted-*` y versiones de esquema descritas arriba; paquetes internos `@game/*` y configuración `GAME_*`.
- Preferencia visual: `ted-theme`.
- Memoria de compilación: `TED_BUILD_MEMORY_MB`, con 512 MB por defecto.

El instalador evita unidades TED duplicadas entre ámbitos del sistema y del usuario actual; dominios y proxies se configuran por separado.

## Identidad de partida

GameState y las vistas de jugador/administrador incluyen `definition: { editionId: 'classic', boardId: 'classic', rulesVersion: 1 }`, independiente de la modalidad Classic/Competitivo. [game-definition.ts](../packages/game-engine/src/game-definition.ts) resuelve definición y datos; [game-runtime.ts](../packages/game-engine/src/game-runtime.ts) resuelve preparación, comandos, invariantes y acciones legales. Reconquista no usa GameState: tiene motor, protocolo y almacenamiento propios (ver abajo).

HTTP create acepta identidad Classic opcional con default Classic, junto con la modalidad; rechaza edición, tablero, versión o campos desconocidos. Los esquemas 5–11 no tienen identidad y se leen como Classic.

## Reconquista

### Código y datos

- Motor: [packages/game-engine/src/reconquista](../packages/game-engine/src/reconquista), publicado como `@game/game-engine/reconquista`. `session.ts` une reparto, objetivos, incorporación inicial, situaciones y primera hostilidad, y guarda el journal; `campaign*.ts` lleva los turnos completos; `cards.ts`, `objectives.ts`, `victory.ts`, `hostilities.ts`, `round.ts` y `situations.ts` cubren cartas, objetivos, victoria, combate, dados y situaciones; `contracts.ts` valida el catálogo y los fixtures de prueba.
- Protocolo: `@game/protocol/reconquista`, versión **4**, con DTOs estrictos. La vista pública lleva tablero, situación, acuerdos, cantidades de cartas y resultados; `self` lleva solo la mano, los objetivos y las acciones legales del jugador. No se publican mazos, sorteos ni el journal.
- Servidor: [routes.ts](../apps/server/src/reconquista/routes.ts) y [store.ts](../apps/server/src/reconquista/store.ts), registrados siempre por `main.ts`.
- Datos del tablero: [apps/server/assets/reconquista](../apps/server/assets/reconquista) tiene el catálogo (`catalog.json`), el mapa claro y oscuro, `labels.json`, `missile-spots.json` y `authority.json`. Al arrancar, el servidor valida el catálogo, compara las huellas de `authority.json` y rechaza arte con estilos en línea (la página usa la CSP de Classic, `style-src 'self'`). El paquete copia la carpeta a `app/assets/reconquista`.

### Rutas y sesiones

- Las partidas se abren en `/game/<id>`, igual que Classic. La web pregunta a `/api/reconquista/games/<id>/entry`; si la partida es de Reconquista muestra su pantalla y si no, la de Classic.
- API bajo `/api/reconquista`: `board`, `art/light|dark`, `games` (anfitrión), `games/<id>/entry`, `join`, `ready`, `start` (anfitrión), `state`, `commands`, `focus`, `live` y `DELETE games/<id>`.
- El anfitrión usa la sesión de administrador de Classic. Cada jugador recibe una cookie por partida con verificador cifrado y vencimiento, guardado en la partida. El cliente nunca elige el actor.
- Toda petición que no sea GET exige el origen de la página (o `GAME_PUBLIC_ORIGIN`). El ingreso tiene límite de intentos.
- Sin `GAME_TRUSTED_PROXY`, el servidor solo atiende pedidos dirigidos a una dirección IP, `localhost`, un nombre `.local` o el nombre de `GAME_PUBLIC_ORIGIN` (protección contra DNS rebinding). Con proxy, el proxy decide qué nombres llegan.
- Reconquista limita comandos, «listo», selecciones y lecturas por asiento válido o anfitrión, y por dirección para el resto; su conexión en vivo exige asiento o sesión de administrador.
- Conexión en vivo: `GET /api/reconquista/games/<id>/live` es un WebSocket de solo lectura que envía `{ "type": "CHANGED" }` tras cada cambio de la partida o de la selección compartida. Cada pantalla vuelve a pedir su propia vista, así que el aviso no lleva datos privados. Hay como máximo 24 conexiones por partida. Mientras la conexión está cortada, la pantalla consulta cada 2 segundos y reintenta conectarse.
- La selección del jugador en turno (`focus`) vive solo en memoria y no entra al journal.

### Almacenamiento, copias y restauración

- Cada partida es `<datos>/reconquista/<id>.json`, con marcador `reconquista.marker`, bloqueo propio de carpeta, coordinador por partida y escrituras atómicas con los resultados COMMITTED/FAILED/INDETERMINATE de Classic. FAILED no confirma; INDETERMINATE deja la partida no disponible hasta reiniciar.
- El sobre es `reconquista-snapshot`/schema 1 y guarda el journal de comandos con sus sorteos, no el estado. Al cargar se vuelve a ejecutar y validar todo; un catálogo distinto (`catalogContract`) o un historial inconsistente se rechaza sin tocar el archivo. El journal admite hasta 50.000 comandos.
- `ted backup` escribe el formato **3**: agrega `reconquista` (las partidas) y `reconquistaGameCount` al manifiesto. `ted restore` valida cada partida de Reconquista con el mismo replay antes de instalar nada; la carpeta `reconquista` anterior queda dentro de la carpeta `pre-restore-…` junto a las partidas Classic previas. Los backups 1 y 2 se restauran sin partidas de Reconquista. Una versión anterior no puede restaurar el formato 3.

### Motor

La primera hostilidad mantiene fuerzas explícitas, dados, fuerzas fijadas y conquista pendiente; solo esa conquista admite cero ejércitos en el destino hasta trasladar 1–3. Los misiles usan la distancia mínima del catálogo (1–3), consumen uno por disparo y no sortean dados. `start-campaign` abre los turnos completos: rotación sobre el círculo fijo, refuerzos por turno, pasada de extras, reemplazo de situación al terminar la vuelta, cartas (73, mano máxima 5, un canje por vuelta), pactos con reloj por turno de la contraparte, zonas internacionales, alianzas y condominios con fuerzas por ocupante, eliminación con herencia y victoria simultánea tras resolver los traslados. Ninguna de estas reglas cambia Classic.
